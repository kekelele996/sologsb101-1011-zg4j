/**
 * 复核流量记录：整编员对某条水位流量关系点据补录的复核流量。
 * 同一次测流、同一水位重复补录时只保留最后一次，以 matchKey 去重。
 */
export interface FlowReview {
  id: string
  /** 复核点据来源测次号（与 Rating.measureNo 对应） */
  measureNo: string
  /** 复核点据水位（m，与 Rating.stageM 对应） */
  stageM: number
  /** 复核流量（m³/s，须大于 0；空或 0 视为放弃，不入库） */
  flowM3s: number
  /** 该复核命中的定线号快照，便于按线刷新比测 */
  lineNo: string
  /** 命中的关系点据 id（可能为多条同测次同水位点据中的第一条，仅作回溯） */
  ratingId: string | null
  /** 复核人 */
  reviewer: string
  /** 复核日期 */
  reviewedAt: string
  createdAt: number
  updatedAt: number
}

/** 复核空记录：用于尚未复核的点据 */
export const NULL_REVIEW = null as FlowReview | null

/**
 * 同一次测流同一水位的匹配键：测次号 + 水位（水位取 2 位小数，避免浮点尾差漏匹配）。
 * Rating 与 FlowReview 两端都用同一函数生成。
 */
export function reviewMatchKey(measureNo: string, stageM: number): string {
  return `${measureNo.trim()}@${Number(stageM).toFixed(2)}`
}

/** 复核流量是否有效：空 / NaN / ≤0 均视为放弃复核 */
export function isValidReviewFlow(flowM3s: number | null | undefined): boolean {
  return typeof flowM3s === 'number' && Number.isFinite(flowM3s) && flowM3s > 0
}

/** 点据当前生效流量：有有效复核取复核值，否则取原始比测流量 */
export function effectiveFlow(
  rating: { measureNo: string; stageM: number; flowM3s: number },
  review: FlowReview | null | undefined
): number {
  if (review && isValidReviewFlow(review.flowM3s)) return review.flowM3s
  return rating.flowM3s
}
