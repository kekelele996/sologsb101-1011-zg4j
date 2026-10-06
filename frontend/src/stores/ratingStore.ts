/**
 * 定线 store：维护水位流量关系点据、比测记录、复核流量、定线参数与残差派生值。
 * 供关系点据页（/ratings）与导出页（/export）共用。
 *
 * 复核流量规则（整编复核补录）：
 * - 某点据补录复核流量后，该点据的曲线流量 / 偏差 / 结论按复核值重算，
 *   定线也以「生效流量」（有复核取复核值）重新拟合，顶部统计与导出结论随之走。
 * - 初次比测结果固化在 Compare.initial 中，复核后照样可回查。
 * - 同一次测流（measureNo）同一水位重复补录，按 matchKey 去重，只留最后一次。
 * - 复核流量空着或为 0 视为放弃，删除复核记录，该点据回到原始比测结果。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { Compare, InitialCompareSnapshot } from '@/types/compare'
import { DEVIATION_LIMIT_PCT, calcDeviationPct, judgeDeviation, type CompareRow } from '@/types/compare'
import type { Rating, RatingFitResult } from '@/types/rating'
import { createEmptyRatingFilter, curveFlow, fitPowerCurve, type RatingFilterState } from '@/types/rating'
import type { FlowReview } from '@/types/review'
import { effectiveFlow, isValidReviewFlow, reviewMatchKey } from '@/types/review'
import type { Station } from '@/types/station'

export const useRatingStore = defineStore('rating', () => {
  const ratings = ref<Rating[]>([])
  const compares = ref<Compare[]>([])
  const reviews = ref<FlowReview[]>([])
  const stations = ref<Station[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const filter = ref<RatingFilterState>(createEmptyRatingFilter())
  /** 当前定线号与定线参数（跨页保留） */
  const activeLineNo = ref<string>('A')
  const fits = ref<RatingFitResult[]>([])
  const deviationLimitPct = ref<number>(DEVIATION_LIMIT_PCT)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Rating>(() => db.ratings).subscribe((rows) => {
      ratings.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<Compare>(() => db.compares).subscribe((rows) => {
      compares.value = rows
    })
    watchTable<FlowReview>(() => db.reviews).subscribe((rows) => {
      reviews.value = rows
    })
    watchTable<Station>(() => db.stations).subscribe((rows) => {
      stations.value = rows
    })
  }

  const lineNos = computed<string[]>(() => {
    const set = new Set<string>()
    ratings.value.forEach((rating) => set.add(rating.lineNo))
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  })

  const stationNameOf = (stationId: string): string =>
    stations.value.find((station) => station.id === stationId)?.name ?? '未知测站'

  /** 复核记录索引：同测次同水位（matchKey）只保留最后一次 */
  const reviewMap = computed<Map<string, FlowReview>>(() => {
    const map = new Map<string, FlowReview>()
    reviews.value
      .slice()
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .forEach((review) => {
        if (isValidReviewFlow(review.flowM3s)) map.set(reviewMatchKey(review.measureNo, review.stageM), review)
      })
    return map
  })

  /** 查找点据命中的复核记录 */
  function reviewOf(rating: Pick<Rating, 'measureNo' | 'stageM'>): FlowReview | null {
    return reviewMap.value.get(reviewMatchKey(rating.measureNo, rating.stageM)) ?? null
  }

  /** 点据当前生效流量（有有效复核取复核值，否则取原始流量） */
  function effectiveFlowOf(rating: Rating): number {
    return effectiveFlow(rating, reviewOf(rating))
  }

  /** 逐定线号的拟合结果（幂函数定线，点据流量取生效值：复核后按复核值重拟） */
  const allFits = computed<RatingFitResult[]>(() =>
    lineNos.value.map((lineNo) => {
      const points = ratings.value
        .filter((rating) => rating.lineNo === lineNo)
        .map((rating) => ({ stageM: rating.stageM, flowM3s: effectiveFlowOf(rating) }))
      return fitPowerCurve(points, lineNo)
    })
  )

  const activeFit = computed<RatingFitResult>(() => {
    const cached = fits.value.find((fit) => fit.lineNo === activeLineNo.value)
    if (cached) return cached
    const computedFit = allFits.value.find((fit) => fit.lineNo === activeLineNo.value)
    if (computedFit) return computedFit
    return fitPowerCurve([], activeLineNo.value)
  })

  /** 点据 + 曲线流量 + 残差（曲线 / 偏差均按生效流量，复核点附初测快照） */
  const pointRows = computed(() =>
    ratings.value
      .filter((rating) => rating.lineNo === activeLineNo.value)
      .sort((a, b) => a.stageM - b.stageM)
      .map((rating) => {
        const review = reviewOf(rating)
        const measured = effectiveFlow(rating, review)
        const compare = compares.value.find((item) => item.ratingId === rating.id) ?? null
        const predicted = compare?.curveFlow ?? (activeFit.value.valid ? curveFlow(activeFit.value, rating.stageM) : 0)
        const deviationPct =
          compare?.deviationPct ??
          (activeFit.value.valid && measured > 0
            ? Number((((predicted - measured) / measured) * 100).toFixed(2))
            : 0)
        const residualPct =
          activeFit.value.valid && measured > 0
            ? Number((((measured - predicted) / measured) * 100).toFixed(2))
            : 0
        return {
          rating,
          review,
          reviewed: review !== null,
          measuredFlow: measured,
          predicted,
          deviationPct,
          residualPct,
          verdict: compare?.verdict ?? (Math.abs(deviationPct) > deviationLimitPct.value ? '超限' : '合格'),
          compare
        }
      })
  )

  /** 已被本次复核改变的点据数（当前线） */
  const reviewedPointCount = computed(() => pointRows.value.filter((row) => row.reviewed).length)

  /** 按筛选条件过滤后的点据 */
  const filteredRatings = computed<Rating[]>(() =>
    ratings.value.filter((rating) => {
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${rating.measureNo}${rating.lineNo}${stationNameOf(rating.stationId)}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.stationIds.length > 0 && !filter.value.stationIds.includes(rating.stationId)) return false
      if (filter.value.lineNos.length > 0 && !filter.value.lineNos.includes(rating.lineNo)) return false
      if (filter.value.verdicts.length > 0) {
        const compare = compares.value.find((item) => item.ratingId === rating.id)
        if (!compare || !filter.value.verdicts.includes(compare.verdict)) return false
      }
      return true
    })
  )

  const hasFilter = computed<boolean>(
    () =>
      filter.value.keyword.trim().length > 0 ||
      filter.value.stationIds.length > 0 ||
      filter.value.lineNos.length > 0 ||
      filter.value.verdicts.length > 0
  )

  /** 比测行：比测记录 + 点据 + 测站名 + 复核记录，导出页与分析清单消费 */
  const compareRows = computed<CompareRow[]>(() =>
    compares.value
      .map((compare) => {
        const rating = ratings.value.find((item) => item.id === compare.ratingId) ?? null
        const review = rating ? reviewOf(rating) : null
        return {
          compare,
          rating,
          stationName: rating ? stationNameOf(rating.stationId) : '点据已删除',
          lineNo: rating?.lineNo ?? '-',
          review,
          reviewed: review !== null,
          initial: compare.initial ?? null
        }
      })
      .sort((a, b) => Math.abs(b.compare.deviationPct) - Math.abs(a.compare.deviationPct))
  )

  const overLimitRows = computed<CompareRow[]>(() =>
    compareRows.value.filter((row) => row.compare.verdict === '超限')
  )

  /** 本次复核后结论发生变化的点据（初测与当前结论不一致） */
  const verdictChangedRows = computed<CompareRow[]>(() =>
    compareRows.value.filter(
      (row) => row.reviewed && row.compare.initial && row.compare.initial.verdict !== row.compare.verdict
    )
  )

  /** 定线质量派生值：平均残差与合格点占比（均按当前生效比测结果） */
  const fitQuality = computed(() => {
    const valid = allFits.value.filter((fit) => fit.valid)
    const meanResidual = valid.length
      ? Number((valid.reduce((sum, fit) => sum + fit.meanResidualPct, 0) / valid.length).toFixed(2))
      : 0
    const total = compareRows.value.length
    const over = overLimitRows.value.length
    return {
      validLineCount: valid.length,
      meanResidualPct: meanResidual,
      compareCount: total,
      overLimitCount: over,
      reviewedCount: compareRows.value.filter((row) => row.reviewed).length,
      qualifyRatePct: total === 0 ? 0 : Number((((total - over) / total) * 100).toFixed(1))
    }
  })

  function patchFilter(patch: Partial<RatingFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyRatingFilter()
  }

  function setActiveLine(lineNo: string): void {
    activeLineNo.value = lineNo
  }

  function setFit(fit: RatingFitResult): void {
    const others = fits.value.filter((item) => item.lineNo !== fit.lineNo)
    fits.value = [...others, fit]
  }

  function setDeviationLimit(limit: number): void {
    deviationLimitPct.value = limit
  }

  async function createRating(
    payload: Omit<Rating, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<Rating> {
    const now = Date.now()
    const row: Rating = { ...payload, id: createId('rat'), createdAt: now, updatedAt: now }
    await db.ratings.put(row)
    return row
  }

  async function updateRating(id: string, patch: Partial<Rating>): Promise<void> {
    await db.ratings.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeRating(id: string): Promise<void> {
    await db.transaction('rw', [db.ratings, db.compares, db.reviews], async () => {
      await db.compares.where('ratingId').equals(id).delete()
      await db.ratings.delete(id)
      // 清理只指向「已不存在点据」的复核记录（同测次同水位另有其他点据时保留）
      const remainingKeys = new Set(
        (await db.ratings.toArray()).map((rating) => reviewMatchKey(rating.measureNo, rating.stageM))
      )
      const orphan = (await db.reviews.toArray())
        .filter((review) => !remainingKeys.has(reviewMatchKey(review.measureNo, review.stageM)))
        .map((review) => review.id)
      if (orphan.length > 0) await db.reviews.bulkDelete(orphan)
    })
  }

  /**
   * 由点据生成 / 刷新某条定线号的比测记录：
   * - 曲线流量按「生效点据」（复核值优先）拟合的当前定线计算；
   * - 实测流量 / 偏差 / 结论按复核值重算，偏差超限自动挂红进入分析清单；
   * - 初测结果只在首次生成时固化进 initial，之后保持不变供回查。
   */
  async function rebuildCompares(lineNo?: string): Promise<number> {
    const targetLine = lineNo ?? activeLineNo.value
    // 直接读库，保证刚写入的复核记录立即生效，不依赖 liveQuery 回流时序
    const [allRatings, allCompares, allReviews] = await Promise.all([
      db.ratings.toArray(),
      db.compares.toArray(),
      db.reviews.toArray()
    ])
    const reviewLookup = new Map<string, FlowReview>()
    allReviews
      .filter((review) => isValidReviewFlow(review.flowM3s))
      .forEach((review) => reviewLookup.set(reviewMatchKey(review.measureNo, review.stageM), review))

    const lineRatings = allRatings.filter((rating) => rating.lineNo === targetLine)
    const fit = fitPowerCurve(
      lineRatings.map((rating) => ({
        stageM: rating.stageM,
        flowM3s: effectiveFlow(rating, reviewLookup.get(reviewMatchKey(rating.measureNo, rating.stageM)) ?? null)
      })),
      targetLine
    )
    setFit(fit)
    if (lineRatings.length === 0) return 0

    const now = Date.now()
    const rows: Compare[] = lineRatings.map((rating) => {
      const existing = allCompares.find((item) => item.ratingId === rating.id)
      const review = reviewLookup.get(reviewMatchKey(rating.measureNo, rating.stageM)) ?? null

      // 初测快照只固化一次：沿用已有 initial；首次生成时用「原始点据（忽略复核）」
      // 单独拟合一条初测定线，确保初测曲线流量 / 偏差 / 结论不被复核带偏。
      let initial: InitialCompareSnapshot | null = existing?.initial ?? null
      if (!initial) {
        const initialFit = fitPowerCurve(
          allRatings
            .filter((item) => item.lineNo === targetLine)
            .map((item) => ({ stageM: item.stageM, flowM3s: item.flowM3s })),
          targetLine
        )
        const initialCurve = initialFit.valid ? curveFlow(initialFit, rating.stageM) : rating.flowM3s
        const initialDeviation = calcDeviationPct(rating.flowM3s, initialCurve)
        initial = {
          measuredFlow: rating.flowM3s,
          curveFlow: initialCurve,
          deviationPct: initialDeviation,
          verdict: judgeDeviation(initialDeviation, deviationLimitPct.value)
        }
      }

      const measuredFlow = review && isValidReviewFlow(review.flowM3s) ? review.flowM3s : rating.flowM3s
      const predicted = fit.valid ? curveFlow(fit, rating.stageM) : measuredFlow
      const deviationPct = calcDeviationPct(measuredFlow, predicted)
      return {
        id: existing?.id ?? createId('cmp'),
        ratingId: rating.id,
        measuredFlow,
        curveFlow: predicted,
        deviationPct,
        verdict: judgeDeviation(deviationPct, deviationLimitPct.value),
        operator: existing?.operator ?? '林昭',
        comparedAt: existing?.comparedAt ?? rating.measuredAt,
        initial,
        reviewFlowM3s: review ? review.flowM3s : null,
        reviewer: review ? review.reviewer : null,
        reviewedAt: review ? review.reviewedAt : null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      }
    })
    await db.compares.bulkPut(rows)
    return rows.length
  }

  /** 全部定线号逐个重算（导入备份 / 整库刷新后使用） */
  async function rebuildAllCompares(): Promise<number> {
    const allRatings = await db.ratings.toArray()
    const lineSet = new Set(allRatings.map((rating) => rating.lineNo))
    let count = 0
    for (const lineNo of lineSet) {
      count += await rebuildCompares(lineNo)
    }
    return count
  }

  /**
   * 补录 / 修改一条复核流量：
   * - flowM3s 为空或 ≤ 0 视为放弃，删除该测次该水位的复核记录，点据回到原比测结果；
   * - 同一次测流同一水位重复补录只留最后一次（按 matchKey 覆盖）；
   * - 命中多个同测次同水位点据时，它们的比测结果一并按复核值重算。
   */
  async function saveReview(input: {
    rating: Rating
    flowM3s: number | null
    reviewer?: string
    reviewedAt?: string
  }): Promise<{ abandoned: boolean; affected: number }> {
    const { rating } = input
    const key = reviewMatchKey(rating.measureNo, rating.stageM)
    const matched = ratings.value.filter(
      (item) => reviewMatchKey(item.measureNo, item.stageM) === key
    )
    const affectedLines = new Set(matched.map((item) => item.lineNo))

    if (!isValidReviewFlow(input.flowM3s)) {
      // 放弃复核：删除该测次该水位的复核记录，受影响点据回到原比测结果
      const stale = reviews.value
        .filter((review) => reviewMatchKey(review.measureNo, review.stageM) === key)
        .map((review) => review.id)
      if (stale.length > 0) await db.reviews.bulkDelete(stale)
      for (const lineNo of affectedLines) await rebuildCompares(lineNo)
      return { abandoned: true, affected: matched.length }
    }

    const now = Date.now()
    const existing = reviews.value.find(
      (review) => reviewMatchKey(review.measureNo, review.stageM) === key
    )
    const row: FlowReview = {
      id: existing?.id ?? createId('rev'),
      measureNo: rating.measureNo,
      stageM: Number(rating.stageM.toFixed(2)),
      flowM3s: Number(input.flowM3s),
      lineNo: rating.lineNo,
      ratingId: rating.id,
      reviewer: input.reviewer?.trim() || '整编复核',
      reviewedAt: input.reviewedAt ?? new Date().toISOString(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    await db.reviews.put(row)
    for (const lineNo of affectedLines) await rebuildCompares(lineNo)
    return { abandoned: false, affected: matched.length }
  }

  /** 手工登记比测记录（导出页分析清单用） */
  async function createCompare(
    payload: Omit<
      Compare,
      | 'id'
      | 'createdAt'
      | 'updatedAt'
      | 'deviationPct'
      | 'verdict'
      | 'initial'
      | 'reviewFlowM3s'
      | 'reviewer'
      | 'reviewedAt'
    > & {
      deviationPct?: number
      verdict?: Compare['verdict']
      initial?: InitialCompareSnapshot
    }
  ): Promise<Compare> {
    const now = Date.now()
    const deviationPct =
      payload.deviationPct ?? calcDeviationPct(payload.measuredFlow, payload.curveFlow)
    const initial: InitialCompareSnapshot =
      payload.initial ?? {
        measuredFlow: payload.measuredFlow,
        curveFlow: payload.curveFlow,
        deviationPct,
        verdict: payload.verdict ?? judgeDeviation(deviationPct, deviationLimitPct.value)
      }
    const row: Compare = {
      ...payload,
      deviationPct,
      verdict: payload.verdict ?? judgeDeviation(deviationPct, deviationLimitPct.value),
      initial,
      reviewFlowM3s: null,
      reviewer: null,
      reviewedAt: null,
      id: createId('cmp'),
      createdAt: now,
      updatedAt: now
    }
    await db.compares.put(row)
    return row
  }

  async function updateCompare(id: string, patch: Partial<Compare>): Promise<void> {
    await db.compares.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeCompare(id: string): Promise<void> {
    await db.compares.delete(id)
  }

  return {
    ratings,
    compares,
    reviews,
    stations,
    ready,
    error,
    filter,
    activeLineNo,
    activeFit,
    fits,
    deviationLimitPct,
    lineNos,
    allFits,
    reviewMap,
    pointRows,
    reviewedPointCount,
    filteredRatings,
    hasFilter,
    compareRows,
    overLimitRows,
    verdictChangedRows,
    fitQuality,
    start,
    stationNameOf,
    reviewOf,
    effectiveFlowOf,
    patchFilter,
    resetFilter,
    setActiveLine,
    setFit,
    setDeviationLimit,
    createRating,
    updateRating,
    removeRating,
    rebuildCompares,
    rebuildAllCompares,
    saveReview,
    createCompare,
    updateCompare,
    removeCompare
  }
})
