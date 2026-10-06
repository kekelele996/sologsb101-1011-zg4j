/**
 * 定线 store：维护水位流量关系点据、比测记录、复核记录、定线参数与残差派生值。
 * 供关系点据页（/ratings）与导出页（/export）共用。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { Compare } from '@/types/compare'
import {
  DEVIATION_LIMIT_PCT,
  buildComparesForLine,
  calcDeviationPct,
  judgeDeviation,
  type CompareRow
} from '@/types/compare'
import type { Rating, RatingFitResult } from '@/types/rating'
import { createEmptyRatingFilter, curveFlow, fitPowerCurve, type RatingFilterState } from '@/types/rating'
import type { Review } from '@/types/review'
import { activeReviewByRatingId, effectiveFlowOf, isEffectiveReviewFlow, reviewKeyOf } from '@/types/review'
import type { Station } from '@/types/station'

export const useRatingStore = defineStore('rating', () => {
  const ratings = ref<Rating[]>([])
  const compares = ref<Compare[]>([])
  const reviews = ref<Review[]>([])
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
    watchTable<Review>(() => db.reviews).subscribe((rows) => {
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

  /** 有效复核索引：ratingId → 复核记录（同测次同水位只留最后一次） */
  const reviewByRatingId = computed<Map<string, Review>>(() => activeReviewByRatingId(reviews.value))

  /** 点据参与定线与比测的有效流量：有复核用复核值，否则用原实测流量 */
  const effectiveFlowOfRating = (rating: Rating): number =>
    effectiveFlowOf(rating, reviewByRatingId.value.get(rating.id) ?? null)

  /** 逐定线号的拟合结果（幂函数定线，复核点据按复核流量入线） */
  const allFits = computed<RatingFitResult[]>(() =>
    lineNos.value.map((lineNo) => {
      const points = ratings.value
        .filter((rating) => rating.lineNo === lineNo)
        .map((rating) => ({ stageM: rating.stageM, flowM3s: effectiveFlowOfRating(rating) }))
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

  /** 点据 + 曲线流量 + 残差（复核点据按复核流量计算） */
  const pointRows = computed(() =>
    ratings.value
      .filter((rating) => rating.lineNo === activeLineNo.value)
      .sort((a, b) => a.stageM - b.stageM)
      .map((rating) => {
        const review = reviewByRatingId.value.get(rating.id) ?? null
        const measured = effectiveFlowOf(rating, review)
        const predicted = activeFit.value.valid ? curveFlow(activeFit.value, rating.stageM) : 0
        const residualPct =
          activeFit.value.valid && measured > 0
            ? Number((((measured - predicted) / measured) * 100).toFixed(2))
            : 0
        return { rating, review, measured, predicted, residualPct }
      })
  )

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

  /** 比测行：比测记录 + 点据 + 测站名 + 生效复核，导出页与分析清单消费 */
  const compareRows = computed<CompareRow[]>(() =>
    compares.value
      .map((compare) => {
        const rating = ratings.value.find((item) => item.id === compare.ratingId) ?? null
        return {
          compare,
          rating,
          stationName: rating ? stationNameOf(rating.stationId) : '点据已删除',
          lineNo: rating?.lineNo ?? '-',
          review: rating ? reviewByRatingId.value.get(rating.id) ?? null : null
        }
      })
      .sort((a, b) => Math.abs(b.compare.deviationPct) - Math.abs(a.compare.deviationPct))
  )

  const overLimitRows = computed<CompareRow[]>(() =>
    compareRows.value.filter((row) => row.compare.verdict === '超限')
  )

  /** 定线质量派生值：平均残差、合格点占比与复核点据数 */
  const fitQuality = computed(() => {
    const valid = allFits.value.filter((fit) => fit.valid)
    const meanResidual = valid.length
      ? Number((valid.reduce((sum, fit) => sum + fit.meanResidualPct, 0) / valid.length).toFixed(2))
      : 0
    const total = compareRows.value.length
    const over = overLimitRows.value.length
    const reviewed = compareRows.value.filter((row) => row.compare.reviewed === true).length
    return {
      validLineCount: valid.length,
      meanResidualPct: meanResidual,
      compareCount: total,
      overLimitCount: over,
      reviewedCount: reviewed,
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
      await db.reviews.where('ratingId').equals(id).delete()
      await db.ratings.delete(id)
    })
  }

  /**
   * 由点据生成 / 刷新比测记录：曲线流量取当前定线拟合值，
   * 有有效复核的点据按复核流量入线与计算偏差，超限自动判定并进入分析清单；
   * 被复核改变的点据保留初次比测快照，放弃复核后回到初次结果。
   */
  async function rebuildCompares(lineNo?: string): Promise<number> {
    const targetLine = lineNo ?? activeLineNo.value
    const targets = ratings.value.filter((rating) => rating.lineNo === targetLine)
    const { compares: rows, fit } = buildComparesForLine({
      lineNo: targetLine,
      ratings: targets,
      reviews: reviews.value,
      existing: compares.value.filter((item) => targets.some((rating) => rating.id === item.ratingId)),
      limitPct: deviationLimitPct.value,
      operatorFallback: '林昭',
      now: Date.now(),
      createId: () => createId('cmp')
    })
    setFit(fit)
    if (targets.length === 0) return 0
    await db.compares.bulkPut(rows)
    return rows.length
  }

  /**
   * 补录复核流量：
   * - 复核流量 > 0：同一次测流同一水位只留最后一次（旧记录先删后写），随后重算定线与比测；
   * - 复核流量为空 / 0：视为放弃复核，删除该点据的复核记录，点据回到初次比测结果。
   */
  async function submitReview(payload: {
    ratingId: string
    reviewFlow: number | null
    operator: string
  }): Promise<'saved' | 'revoked' | 'missing'> {
    const rating = ratings.value.find((item) => item.id === payload.ratingId)
    if (!rating) return 'missing'
    const key = reviewKeyOf(rating.measureNo, rating.stageM)
    const effective = isEffectiveReviewFlow(payload.reviewFlow)
    const now = Date.now()
    await db.transaction('rw', [db.reviews], async () => {
      // 同测次同水位的历史复核只留最后一次：按去重键或同点据清掉旧记录
      const staleIds = reviews.value
        .filter((item) => item.ratingId === rating.id || reviewKeyOf(item.measureNo, item.stageM) === key)
        .map((item) => item.id)
      if (staleIds.length > 0) await db.reviews.bulkDelete(staleIds)
      if (effective) {
        await db.reviews.put({
          id: createId('rev'),
          ratingId: rating.id,
          measureNo: rating.measureNo,
          stageM: rating.stageM,
          reviewFlow: payload.reviewFlow as number,
          operator: payload.operator.trim() || '林昭',
          reviewedAt: new Date(now).toISOString(),
          createdAt: now,
          updatedAt: now
        })
      }
    })
    await rebuildCompares(rating.lineNo)
    return effective ? 'saved' : 'revoked'
  }

  /** 手工登记比测记录（导出页分析清单用） */
  async function createCompare(
    payload: Omit<Compare, 'id' | 'createdAt' | 'updatedAt' | 'deviationPct' | 'verdict'> & {
      deviationPct?: number
      verdict?: Compare['verdict']
    }
  ): Promise<Compare> {
    const now = Date.now()
    const deviationPct =
      payload.deviationPct ?? calcDeviationPct(payload.measuredFlow, payload.curveFlow)
    const row: Compare = {
      ...payload,
      deviationPct,
      verdict: payload.verdict ?? judgeDeviation(deviationPct, deviationLimitPct.value),
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
    reviewByRatingId,
    pointRows,
    filteredRatings,
    hasFilter,
    compareRows,
    overLimitRows,
    fitQuality,
    start,
    stationNameOf,
    effectiveFlowOfRating,
    patchFilter,
    resetFilter,
    setActiveLine,
    setFit,
    setDeviationLimit,
    createRating,
    updateRating,
    removeRating,
    rebuildCompares,
    submitReview,
    createCompare,
    updateCompare,
    removeCompare
  }
})
