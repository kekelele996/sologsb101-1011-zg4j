import type { Rating } from './rating'
import { curveFlow, fitPowerCurve, type RatingFitResult } from './rating'
import type { Review, ReviewLike } from './review'
import { activeReviewByRatingId, effectiveFlowOf } from './review'

/** 比测判定结论 */
export type CompareVerdict = '合格' | '超限'

/** 比测偏差允许限值（%）：超过则判定超限并挂红 */
export const DEVIATION_LIMIT_PCT = 8

/** 初次比测快照：首次补录复核前的比测结果，供整编员回查 */
export interface CompareInitialSnapshot {
  /** 初次实测流量（m³/s） */
  measuredFlow: number
  /** 初次曲线流量（m³/s） */
  curveFlow: number
  /** 初次偏差（%） */
  deviationPct: number
  /** 初次判定结论 */
  verdict: CompareVerdict
}

/** 比测记录：实测流量与曲线流量的偏差分析 */
export interface Compare {
  id: string
  /** 被比测的关系点据 */
  ratingId: string
  /** 实测流量（m³/s）：有有效复核时为复核流量 */
  measuredFlow: number
  /** 曲线流量（m³/s） */
  curveFlow: number
  /** 偏差（%）：(曲线 - 实测) / 实测 × 100 */
  deviationPct: number
  /** 合格 / 超限 */
  verdict: CompareVerdict
  /** 当前结果是否按复核流量计算 */
  reviewed?: boolean
  /** 初次比测快照：仅在被复核改变过的点据上保留；放弃复核后清除 */
  initial?: CompareInitialSnapshot | null
  /** 比测人 */
  operator: string
  /** 比测日期 */
  comparedAt: string
  createdAt: number
  updatedAt: number
}

/** 按偏差计算判定结论 */
export function judgeDeviation(deviationPct: number, limit = DEVIATION_LIMIT_PCT): CompareVerdict {
  return Math.abs(deviationPct) > limit ? '超限' : '合格'
}

/** 计算偏差百分比 */
export function calcDeviationPct(measuredFlow: number, curveFlowValue: number): number {
  if (!Number.isFinite(measuredFlow) || measuredFlow === 0) return 0
  return Number((((curveFlowValue - measuredFlow) / measuredFlow) * 100).toFixed(2))
}

/** 比测行：比测记录 + 所属点据，供导出页与分析清单展示 */
export interface CompareRow {
  compare: Compare
  rating: Rating | null
  stationName: string
  lineNo: string
  /** 该点据当前生效的复核记录（无复核为 null） */
  review?: Review | null
}

/**
 * 重建一条定线的比测记录（纯函数，ratingStore 与演示数据播种共用）。
 * - 有有效复核的点据按复核流量参与定线拟合与偏差计算；
 * - 首次被复核改变的点据把复核前结果存入 initial 快照，之后重复复核不覆盖；
 * - 复核被放弃（记录已删除）的点据回到初次比测结果，快照清除。
 */
export function buildComparesForLine(options: {
  lineNo: string
  /** 该定线号下的全部点据（播种场景允许缺省时间戳） */
  ratings: Array<Pick<Rating, 'id' | 'stageM' | 'flowM3s' | 'measuredAt'>>
  /** 全量复核记录（函数内部去重并按键匹配；播种数据可缺省时间戳以外的字段） */
  reviews: ReviewLike[]
  /** 现有比测记录（沿用 id / 比测人 / 初次快照） */
  existing: Compare[]
  /** 偏差限值（%） */
  limitPct: number
  /** 新建记录时的默认比测人 */
  operatorFallback?: string
  now: number
  createId: () => string
}): { compares: Compare[]; fit: RatingFitResult } {
  const { lineNo, ratings, reviews, existing, limitPct, now, createId } = options
  const reviewMap = activeReviewByRatingId(reviews)
  const existingMap = new Map(existing.map((compare) => [compare.ratingId, compare]))

  // 定线拟合使用有效流量：复核过的点据以复核流量入线，曲线流量随之按复核值算
  const fit = fitPowerCurve(
    ratings.map((rating) => ({
      stageM: rating.stageM,
      flowM3s: effectiveFlowOf(rating, reviewMap.get(rating.id) ?? null)
    })),
    lineNo
  )

  // 初次结果兜底：点据还没有历史比测记录时，用原始实测流量拟合的定线估算初次曲线流量
  let initialFit: RatingFitResult | null = null
  const fallbackInitialFit = (): RatingFitResult => {
    if (!initialFit) {
      initialFit = fitPowerCurve(
        ratings.map((rating) => ({ stageM: rating.stageM, flowM3s: rating.flowM3s })),
        lineNo
      )
    }
    return initialFit
  }

  const compares: Compare[] = ratings.map((rating) => {
    const review = reviewMap.get(rating.id) ?? null
    const measuredFlow = effectiveFlowOf(rating, review)
    const predicted = fit.valid ? curveFlow(fit, rating.stageM) : measuredFlow
    const deviationPct = calcDeviationPct(measuredFlow, predicted)
    const verdict = judgeDeviation(deviationPct, limitPct)
    const old = existingMap.get(rating.id)

    let initial: CompareInitialSnapshot | null = null
    if (review) {
      if (old?.initial) {
        // 重复复核：初次快照保持不变
        initial = old.initial
      } else if (old && !old.reviewed) {
        // 首次复核：现有记录即复核前的初次结果，直接快照
        initial = {
          measuredFlow: old.measuredFlow,
          curveFlow: old.curveFlow,
          deviationPct: old.deviationPct,
          verdict: old.verdict
        }
      } else {
        // 无历史记录（如新点据首次定线就带复核）：按原始流量估算初次结果
        const baseFit = fallbackInitialFit()
        const baseCurve = baseFit.valid ? curveFlow(baseFit, rating.stageM) : rating.flowM3s
        const baseDeviation = calcDeviationPct(rating.flowM3s, baseCurve)
        initial = {
          measuredFlow: rating.flowM3s,
          curveFlow: baseCurve,
          deviationPct: baseDeviation,
          verdict: judgeDeviation(baseDeviation, limitPct)
        }
      }
    }

    return {
      id: old?.id ?? createId(),
      ratingId: rating.id,
      measuredFlow,
      curveFlow: predicted,
      deviationPct,
      verdict,
      reviewed: review !== null,
      initial,
      operator: old?.operator ?? options.operatorFallback ?? '林昭',
      comparedAt: old?.comparedAt ?? rating.measuredAt,
      createdAt: old?.createdAt ?? now,
      updatedAt: now
    }
  })
  return { compares, fit }
}
