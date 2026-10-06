import type { Rating } from './rating'
import type { FlowReview } from './review'

/** 比测判定结论 */
export type CompareVerdict = '合格' | '超限'

/** 比测偏差允许限值（%）：超过则判定超限并挂红 */
export const DEVIATION_LIMIT_PCT = 8

/** 初次比测结果快照：补录复核流量后仍可据此回查初测结论 */
export interface InitialCompareSnapshot {
  /** 初测实测流量（m³/s），即点据原始流量 */
  measuredFlow: number
  /** 初测曲线流量（m³/s），按原始点据定线计算 */
  curveFlow: number
  /** 初测偏差（%） */
  deviationPct: number
  /** 初测结论 */
  verdict: CompareVerdict
}

/** 比测记录：实测流量与曲线流量的偏差分析 */
export interface Compare {
  id: string
  /** 被比测的关系点据 */
  ratingId: string
  /** 当前生效实测流量（m³/s）：有复核取复核值，否则取初测值 */
  measuredFlow: number
  /** 曲线流量（m³/s）：按生效点据重新定线后在该水位处的曲线值 */
  curveFlow: number
  /** 偏差（%）：(曲线 - 实测) / 实测 × 100 */
  deviationPct: number
  /** 合格 / 超限（按当前生效流量判定） */
  verdict: CompareVerdict
  /** 比测人 */
  operator: string
  /** 比测日期 */
  comparedAt: string
  /** 初测结果快照（初次定线比测时固化，复核后不变，供整编员回查） */
  initial: InitialCompareSnapshot
  /** 本次复核流量（m³/s）：null 表示该点据尚未复核 */
  reviewFlowM3s: number | null
  /** 复核人：null 表示未复核 */
  reviewer: string | null
  /** 复核日期：null 表示未复核 */
  reviewedAt: string | null
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

/** 该比测记录是否已被本次复核改变（存在有效复核流量） */
export function hasReview(compare: Compare): boolean {
  return typeof compare.reviewFlowM3s === 'number' && compare.reviewFlowM3s > 0
}

/** 比测行：比测记录 + 所属点据，供导出页与分析清单展示 */
export interface CompareRow {
  compare: Compare
  rating: Rating | null
  stationName: string
  lineNo: string
  /** 命中的复核记录（无则为 null） */
  review: FlowReview | null
  /** 是否已复核 */
  reviewed: boolean
  /** 初测结果快照（导入旧备份尚未重算时可能为 null，UI 需做空值回退） */
  initial: InitialCompareSnapshot | null
}
