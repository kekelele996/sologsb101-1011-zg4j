import type { Rating } from './rating'

/**
 * 复核记录：对关系点据补录的复核流量。
 * 同一次测流同一水位（measureNo + stageM）只保留最后一次补录；
 * 复核流量为空或为 0 视为放弃复核，不落库。
 */
export interface Review {
  id: string
  /** 被复核的关系点据 */
  ratingId: string
  /** 测次号（冗余自点据，用于同测次同水位去重） */
  measureNo: string
  /** 水位（m，冗余自点据，用于同测次同水位去重） */
  stageM: number
  /** 复核流量（m³/s），必须大于 0 */
  reviewFlow: number
  /** 复核人 */
  operator: string
  /** 复核时间 */
  reviewedAt: string
  createdAt: number
  updatedAt: number
}

/** 复核去重键：同一次测流同一水位视为同一条复核 */
export function reviewKeyOf(measureNo: string, stageM: number): string {
  return `${measureNo.trim()}@${stageM.toFixed(2)}`
}

/** 复核流量是否有效：有限且大于 0；空 / 0 视为放弃复核 */
export function isEffectiveReviewFlow(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** 参与去重与匹配所需的最小字段集（播种数据尚未补时间戳时同样可用） */
export type ReviewLike = Pick<Review, 'ratingId' | 'measureNo' | 'stageM' | 'reviewFlow' | 'createdAt'>

/**
 * 复核去重：同一（测次号, 水位）只保留最后一次补录（createdAt 最大者）。
 * 写入侧已按键删除旧记录，这里兜底处理导入备份等可能带入的重复。
 */
export function dedupeLatestReviews<T extends ReviewLike>(reviews: T[]): T[] {
  const latest = new Map<string, T>()
  reviews.forEach((review) => {
    const key = reviewKeyOf(review.measureNo, review.stageM)
    const existing = latest.get(key)
    if (!existing || existing.createdAt <= review.createdAt) {
      latest.set(key, review)
    }
  })
  return Array.from(latest.values())
}

/** 有效复核索引：ratingId → 复核记录（已去重，且复核流量 > 0；同点据多条时取最新） */
export function activeReviewByRatingId<T extends ReviewLike>(reviews: T[]): Map<string, T> {
  const map = new Map<string, T>()
  dedupeLatestReviews(reviews).forEach((review) => {
    if (!isEffectiveReviewFlow(review.reviewFlow)) return
    const existing = map.get(review.ratingId)
    if (!existing || existing.createdAt <= review.createdAt) {
      map.set(review.ratingId, review)
    }
  })
  return map
}

/** 点据参与定线与比测的有效流量：有有效复核用复核值，否则用原实测流量 */
export function effectiveFlowOf(
  rating: Pick<Rating, 'flowM3s'>,
  review?: Pick<Review, 'reviewFlow'> | null
): number {
  return review && isEffectiveReviewFlow(review.reviewFlow) ? review.reviewFlow : rating.flowM3s
}
