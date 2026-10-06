<script setup lang="ts">
/**
 * 模块 5：/ratings 水位流量关系点据与定线
 * 幂函数拟合 Q = a×(H-H0)^b、残差展示、超限点据挂红，并同步 URL query。
 * 支持按点据补录复核流量：补录后曲线流量 / 偏差 / 结论按复核值重算，
 * 同表保留初次比测结果；仅看本次复核变更可快速定位变化点据。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, DocumentChecked, Edit, Plus, Refresh, TrendCharts } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import type { FilterModel } from '@/types/filter'
import StatBadge from '@/components/common/StatBadge.vue'
import DeviationTag from '@/components/common/DeviationTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useRatingStore } from '@/stores/ratingStore'
import { useStationStore } from '@/stores/stationStore'
import { fitPowerCurve, type Rating, type RatingFitResult } from '@/types/rating'
import { initDatabase } from '@/utils/db'

const route = useRoute()
const router = useRouter()
const ratingStore = useRatingStore()
const stationStore = useStationStore()

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const form = reactive({
  stationId: '',
  stageM: 0,
  flowM3s: 0,
  lineNo: 'A',
  measureNo: '',
  measuredAt: new Date().toISOString().slice(0, 16)
})

/** 复核补录弹窗 */
const reviewDialogVisible = ref(false)
const reviewSubmitting = ref(false)
const reviewTarget = ref<Rating | null>(null)
const reviewForm = reactive<{
  flowM3s: number | undefined
  reviewer: string
  reviewedAt: string
}>({
  flowM3s: undefined,
  reviewer: '',
  reviewedAt: new Date().toISOString().slice(0, 16)
})

/** 仅显示本次复核后发生变化的点据 */
const reviewedOnly = ref(false)

const fit = computed(() => ratingStore.activeFit)
const lineNos = computed(() => (ratingStore.lineNos.length > 0 ? ratingStore.lineNos : ['A']))

/** 当前定线号下的点据：实测/曲线/偏差均为生效值，另带初测快照与复核信息 */
const allRows = computed(() =>
  ratingStore.pointRows.map((row) => ({
    ...row,
    stationName: ratingStore.stationNameOf(row.rating.stationId),
    initialFlow: row.compare?.initial?.measuredFlow ?? row.rating.flowM3s,
    initialCurve: row.compare?.initial?.curveFlow ?? null,
    initialDeviationPct: row.compare?.initial?.deviationPct ?? null,
    initialVerdict: row.compare?.initial?.verdict ?? null,
    reviewerText: row.review
      ? `${row.review.reviewer} · ${new Date(row.review.reviewedAt).toLocaleDateString('zh-CN')}`
      : ''
  }))
)

/** 表格行：打开「仅看复核变更」时只列本次复核过的点据 */
const tableRows = computed(() =>
  reviewedOnly.value ? allRows.value.filter((row) => row.reviewed) : allRows.value
)

const filterModel = computed<FilterModel>(() => ({
  keyword: ratingStore.filter.keyword,
  stationIds: ratingStore.filter.stationIds,
  lineNos: ratingStore.filter.lineNos,
  verdicts: ratingStore.filter.verdicts
}))

/** 关系曲线坐标：横轴水位、纵轴流量（生效流量落点，复核点另画初测空心点） */
const chart = computed(() => {
  const rows = allRows.value
  if (rows.length === 0) {
    return {
      samples: '',
      points: [] as Array<{ id: string; cx: number; cy: number; verdict: string; reviewed: boolean }>,
      initialPoints: [] as Array<{ id: string; cx: number; cy: number }>,
      stageMin: 0,
      stageMax: 0,
      flowMax: 0
    }
  }
  const stages = rows.map((row) => row.rating.stageM)
  const flows = rows.flatMap((row) => [row.measuredFlow, row.initialFlow])
  const stageMin = Math.min(...stages)
  const stageMax = Math.max(...stages)
  const flowMax = Math.max(...flows) * 1.1
  const left = 52
  const right = 328
  const top = 20
  const bottom = 190
  const toX = (stageM: number): number =>
    stageMax - stageMin < 1e-6 ? (left + right) / 2 : left + ((stageM - stageMin) / (stageMax - stageMin)) * (right - left)
  const toY = (flowM3s: number): number => bottom - (flowM3s / flowMax) * (bottom - top)
  const sampleCount = 13
  const samples = Array.from({ length: sampleCount }, (_, index) => {
    const stageM = stageMin + ((stageMax - stageMin) * index) / (sampleCount - 1 || 1)
    const value = fit.value.valid ? fit.value.a * Math.pow(Math.max(stageM - fit.value.h0, 1e-6), fit.value.b) : 0
    return `${toX(stageM).toFixed(1)},${toY(value).toFixed(1)}`
  }).join(' ')
  return {
    samples,
    points: rows.map((row) => ({
      id: row.rating.id,
      cx: toX(row.rating.stageM),
      cy: toY(row.measuredFlow),
      verdict: row.verdict,
      reviewed: row.reviewed
    })),
    initialPoints: rows
      .filter((row) => row.reviewed && Math.abs(row.initialFlow - row.measuredFlow) > 1e-6)
      .map((row) => ({
        id: `${row.rating.id}-initial`,
        cx: toX(row.rating.stageM),
        cy: toY(row.initialFlow)
      })),
    stageMin,
    stageMax,
    flowMax
  }
})

function openCreate(): void {
  editingId.value = null
  form.stationId = stationStore.currentStationId ?? stationStore.stations[0]?.id ?? ''
  form.lineNo = ratingStore.activeLineNo
  const last = allRows.value[allRows.value.length - 1]
  form.stageM = last ? Number((last.rating.stageM + 0.2).toFixed(2)) : 3
  form.flowM3s = last ? Number((last.measuredFlow * 1.2).toFixed(1)) : 50
  form.measureNo = `${new Date().getFullYear()}-${String(ratingStore.ratings.length + 1).padStart(3, '0')}`
  form.measuredAt = new Date().toISOString().slice(0, 16)
  dialogVisible.value = true
}

function openEdit(rating: Rating): void {
  editingId.value = rating.id
  form.stationId = rating.stationId
  form.stageM = rating.stageM
  form.flowM3s = rating.flowM3s
  form.lineNo = rating.lineNo
  form.measureNo = rating.measureNo
  form.measuredAt = rating.measuredAt.slice(0, 16)
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.stationId) {
    ElMessage.warning('请选择所属测站')
    return
  }
  if (!Number.isFinite(form.stageM)) {
    ElMessage.warning('请填写水位（m）')
    return
  }
  if (!Number.isFinite(form.flowM3s) || form.flowM3s <= 0) {
    ElMessage.warning('流量应为大于 0 的数字（m³/s）')
    return
  }
  submitting.value = true
  try {
    const payload = {
      stationId: form.stationId,
      stageM: form.stageM,
      flowM3s: form.flowM3s,
      lineNo: form.lineNo.trim() || 'A',
      measureNo: form.measureNo.trim(),
      measuredAt: form.measuredAt ? new Date(form.measuredAt).toISOString() : new Date().toISOString()
    }
    if (editingId.value) {
      await ratingStore.updateRating(editingId.value, payload)
      ElMessage.success('点据已更新')
    } else {
      await ratingStore.createRating(payload)
      ElMessage.success('点据已新增，正在重算定线')
    }
    ratingStore.setActiveLine(payload.lineNo)
    dialogVisible.value = false
    await ratingStore.rebuildCompares(payload.lineNo)
  } finally {
    submitting.value = false
  }
}

async function removeRating(rating: Rating): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除水位 ${rating.stageM.toFixed(2)} m 处的点据将同时删除其比测记录，确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await ratingStore.removeRating(rating.id)
  await ratingStore.rebuildCompares(rating.lineNo)
  ElMessage.success('点据已删除并重算定线')
}

/** 打开复核流量补录弹窗（已有复核时回显，可改录或放弃） */
function openReview(row: (typeof allRows.value)[number]): void {
  reviewTarget.value = row.rating
  reviewForm.flowM3s = row.reviewed ? row.measuredFlow : undefined
  reviewForm.reviewer = row.review?.reviewer ?? ''
  reviewForm.reviewedAt = row.review
    ? row.review.reviewedAt.slice(0, 16)
    : new Date().toISOString().slice(0, 16)
  reviewDialogVisible.value = true
}

/** 保存复核：同测次同水位的重复补录只留最后一次；空 / 0 走放弃逻辑 */
async function submitReview(): Promise<void> {
  const target = reviewTarget.value
  if (!target) return
  const flow = reviewForm.flowM3s
  const shouldAbandon = flow === undefined || flow === null || !Number.isFinite(flow) || flow <= 0
  if (shouldAbandon) {
    try {
      await ElMessageBox.confirm(
        '复核流量空着或为 0 将视为放弃复核，该点据回到初次比测结果（曲线流量、偏差与结论恢复）。确认放弃？',
        '放弃复核',
        { type: 'warning', confirmButtonText: '放弃复核', cancelButtonText: '继续填写' }
      )
    } catch {
      return
    }
  }
  reviewSubmitting.value = true
  try {
    const result = await ratingStore.saveReview({
      rating: target,
      flowM3s: shouldAbandon ? null : Number(flow),
      reviewer: reviewForm.reviewer,
      reviewedAt: reviewForm.reviewedAt ? new Date(reviewForm.reviewedAt).toISOString() : new Date().toISOString()
    })
    reviewDialogVisible.value = false
    if (result.abandoned) {
      ElMessage.success('已放弃复核，点据回到初次比测结果')
    } else {
      ElMessage.success(
        `复核流量已补录，曲线流量、偏差与结论按复核值重算（同测次同水位共 ${result.affected} 条点据）`
      )
    }
  } finally {
    reviewSubmitting.value = false
  }
}

/** 弹窗内显式「放弃复核」按钮 */
async function abandonReview(): Promise<void> {
  const target = reviewTarget.value
  if (!target) return
  reviewSubmitting.value = true
  try {
    const result = await ratingStore.saveReview({ rating: target, flowM3s: null })
    reviewDialogVisible.value = false
    ElMessage.success(
      result.affected > 0
        ? `已放弃复核，${result.affected} 条点据回到初次比测结果`
        : '已放弃复核，点据回到初次比测结果'
    )
  } finally {
    reviewSubmitting.value = false
  }
}

async function refit(): Promise<void> {
  const result: RatingFitResult = fitPowerCurve(
    allRows.value.map((row) => ({ stageM: row.rating.stageM, flowM3s: row.measuredFlow })),
    ratingStore.activeLineNo
  )
  ratingStore.setFit(result)
  const count = await ratingStore.rebuildCompares(ratingStore.activeLineNo)
  if (result.valid) {
    ElMessage.success(
      `定线完成：Q = ${result.a}×(H-${result.h0})^${result.b}，平均残差 ${result.meanResidualPct}%，刷新比测 ${count} 条`
    )
  } else {
    ElMessage.warning(result.message || '当前点据不足以定线')
  }
}

function handleLineChange(lineNo: string | number | boolean | undefined): void {
  ratingStore.setActiveLine(String(lineNo))
  void ratingStore.rebuildCompares(String(lineNo))
}

function handleFilterChange(): void {
  void router.replace({
    query: {
      ...(ratingStore.filter.keyword.trim() ? { kw: ratingStore.filter.keyword.trim() } : {}),
      ...(ratingStore.filter.stationIds.length ? { stations: ratingStore.filter.stationIds.join(',') } : {}),
      ...(ratingStore.filter.lineNos.length ? { lines: ratingStore.filter.lineNos.join(',') } : {}),
      ...(ratingStore.filter.verdicts.length ? { verdict: ratingStore.filter.verdicts.join(',') } : {}),
      ...(reviewedOnly.value ? { rv: '1' } : {})
    }
  })
}

function handleReset(): void {
  ratingStore.resetFilter()
  reviewedOnly.value = false
  void router.replace({ query: {} })
}

function rowClassName({ row }: { row: (typeof allRows.value)[number] }): string {
  return row.reviewed ? 'gb-row-reviewed' : ''
}

onMounted(() => {
  if (stationStore.stations.length === 0) void initDatabase()
  const query = route.query
  ratingStore.patchFilter({
    keyword: typeof query.kw === 'string' ? query.kw : '',
    stationIds: typeof query.stations === 'string' ? query.stations.split(',') : [],
    lineNos: typeof query.lines === 'string' ? query.lines.split(',') : [],
    verdicts:
      typeof query.verdict === 'string'
        ? (query.verdict.split(',').filter((item) => item === '合格' || item === '超限') as Array<'合格' | '超限'>)
        : []
  })
  reviewedOnly.value = query.rv === '1'
  void ratingStore.rebuildCompares(ratingStore.activeLineNo)
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">水位流量关系点据与定线</h2>
        <p class="gb-hint">
          点据按定线号分组做幂函数拟合 Q = a×(H-H0)^b，残差超过 {{ ratingStore.deviationLimitPct }}% 的点据自动挂红并进入比测分析清单；
          补录复核流量后，该点据的曲线流量、偏差与结论按复核值重算，初次比测结果仍可在表内回查。
        </p>
      </div>
      <div class="page__actions">
        <el-select
          :model-value="ratingStore.activeLineNo"
          class="page__line-select"
          @change="handleLineChange"
        >
          <el-option v-for="lineNo in lineNos" :key="lineNo" :label="`${lineNo} 线`" :value="lineNo" />
        </el-select>
        <el-button :icon="Refresh" @click="refit">重新定线</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增点据</el-button>
      </div>
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="[
        {
          key: 'stationIds',
          label: '测站',
          options: stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
        },
        { key: 'lineNos', label: '定线号', options: lineNos.map((lineNo) => ({ label: `${lineNo} 线`, value: lineNo })) },
        {
          key: 'verdicts',
          label: '判定',
          options: [
            { label: '合格', value: '合格' },
            { label: '超限', value: '超限' }
          ]
        }
      ]"
      keyword-placeholder="搜索测次号 / 定线号 / 测站"
      @change="handleFilterChange"
      @reset="handleReset"
    >
      <template #extra>
        <el-switch
          v-model="reviewedOnly"
          active-text="仅看复核变更"
          inline-prompt
          @change="handleFilterChange"
        />
      </template>
    </FilterBar>

    <div class="gb-stats-row">
      <StatBadge label="current 线点据" :value="allRows.length" suffix="点" icon="DataLine" />
      <StatBadge
        label="定线系数 a"
        :value="fit.valid ? fit.a : '—'"
        :suffix="fit.valid ? `b=${fit.b}` : '未定线'"
        tone="info"
        icon="TrendCharts"
      />
      <StatBadge
        label="平均残差"
        :value="fit.valid ? fit.meanResidualPct : '—'"
        suffix="%"
        :tone="fit.valid && fit.meanResidualPct <= ratingStore.deviationLimitPct ? 'success' : 'warning'"
        icon="Histogram"
      />
      <StatBadge
        label="超限点据"
        :value="allRows.filter((row) => row.verdict === '超限').length"
        suffix="点"
        :tone="allRows.some((row) => row.verdict === '超限') ? 'danger' : 'success'"
        :icon="allRows.some((row) => row.verdict === '超限') ? 'WarningFilled' : 'DataLine'"
      />
      <StatBadge
        label="复核变更"
        :value="ratingStore.reviewedPointCount"
        suffix="点"
        :tone="ratingStore.reviewedPointCount > 0 ? 'warning' : 'success'"
        icon="PieChart"
      />
    </div>

    <el-alert
      v-if="!fit.valid"
      type="warning"
      show-icon
      :closable="false"
      :title="fit.message || '当前定线号下点据不足，至少需要 3 个实测点才能定线'"
    />
    <el-alert
      v-else
      type="success"
      show-icon
      :closable="false"
      :title="`${fit.lineNo} 线定线有效：Q = ${fit.a} × (H - ${fit.h0})^${fit.b}；样本 ${fit.sampleCount} 点，平均残差 ${fit.meanResidualPct}%，最大残差 ${fit.maxResidualPct}%`"
    />

    <div class="page__grid">
      <EmptyPanel
        v-if="tableRows.length === 0"
        :title="reviewedOnly ? '当前定线号还没有复核变更的点据' : '该定线号下还没有关系点据'"
        :description="
          reviewedOnly
            ? '关闭「仅看复核变更」可查看全部点据；在点据行点击「补录复核」可录入复核流量。'
            : '录入实测水位与流量点据后即可做幂函数定线；也可以先切换到其他定线号查看已有成果。'
        "
        :action-text="reviewedOnly ? '' : '新增点据'"
        @action="reviewedOnly ? undefined : openCreate()"
      />

      <el-table
        v-else
        :data="tableRows"
        border
        stripe
        class="gb-table-compact"
        :row-class-name="rowClassName"
      >
        <el-table-column label="水位 (m)" width="100" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.rating.stageM.toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="实测流量 (m³/s)" width="160" align="right">
          <template #default="{ row }">
            <div class="gb-cell-main gb-mono">{{ row.measuredFlow.toFixed(1) }}</div>
            <div v-if="row.reviewed" class="gb-cell-sub gb-mono">初测 {{ row.initialFlow.toFixed(1) }}</div>
          </template>
        </el-table-column>
        <el-table-column label="曲线流量 (m³/s)" width="160" align="right">
          <template #default="{ row }">
            <div class="gb-cell-main gb-mono">{{ row.predicted > 0 ? row.predicted.toFixed(1) : '—' }}</div>
            <div v-if="row.reviewed && row.initialCurve !== null" class="gb-cell-sub gb-mono">
              初测 {{ row.initialCurve.toFixed(1) }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="偏差判定" min-width="220">
          <template #default="{ row }">
            <DeviationTag
              :deviation-pct="row.deviationPct"
              :verdict="row.verdict"
              :limit="ratingStore.deviationLimitPct"
            />
            <div v-if="row.reviewed && row.initialVerdict" class="gb-cell-sub">
              <span class="gb-cell-sub__label">初测</span>
              <DeviationTag
                :deviation-pct="row.initialDeviationPct ?? 0"
                :verdict="row.initialVerdict"
                :limit="ratingStore.deviationLimitPct"
                size="small"
              />
            </div>
          </template>
        </el-table-column>
        <el-table-column label="测站 / 测次" min-width="180">
          <template #default="{ row }">
            <div class="gb-cell-main">{{ row.stationName }}</div>
            <div class="gb-cell-sub gb-mono">{{ row.rating.measureNo || '未标记测次' }}</div>
            <el-tag v-if="row.reviewed" type="warning" size="small" effect="plain">
              复核 · {{ row.reviewerText }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="点据时间" width="120">
          <template #default="{ row }">
            <span class="gb-mono">{{ new Date(row.rating.measuredAt).toLocaleDateString('zh-CN') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="240" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :type="row.reviewed ? 'warning' : 'primary'" plain :icon="DocumentChecked" @click="openReview(row)">
              {{ row.reviewed ? '改录复核' : '补录复核' }}
            </el-button>
            <el-button size="small" :icon="Edit" @click="openEdit(row.rating)">编辑</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeRating(row.rating)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-card shadow="never" class="page__chart-card">
        <div class="gb-panel-title">
          <h3>{{ ratingStore.activeLineNo }} 线关系曲线</h3>
          <el-icon><TrendCharts /></el-icon>
        </div>
        <svg v-if="allRows.length > 0" viewBox="0 0 360 220" class="page__chart">
          <line x1="52" y1="190" x2="340" y2="190" stroke="#b9cfdd" />
          <line x1="52" y1="20" x2="52" y2="190" stroke="#b9cfdd" />
          <text x="6" y="24" class="gb-chart-axis">{{ chart.flowMax.toFixed(0) }}</text>
          <text x="14" y="194" class="gb-chart-axis">0</text>
          <text x="52" y="208" class="gb-chart-axis">{{ chart.stageMin.toFixed(2) }}</text>
          <text x="300" y="208" class="gb-chart-axis">{{ chart.stageMax.toFixed(2) }} m</text>
          <polyline v-if="fit.valid" :points="chart.samples" fill="none" stroke="#0f4c75" stroke-width="2" />
          <circle
            v-for="point in chart.initialPoints"
            :key="point.id"
            :cx="point.cx"
            :cy="point.cy"
            r="5.5"
            fill="none"
            stroke="#9aa7b1"
            stroke-width="1.5"
            stroke-dasharray="2 2"
          />
          <circle
            v-for="point in chart.points"
            :key="point.id"
            :cx="point.cx"
            :cy="point.cy"
            r="4.5"
            :fill="point.reviewed ? '#e08a1e' : point.verdict === '超限' ? '#c0392b' : '#7fd1e8'"
            :stroke="point.reviewed ? '#9c5a00' : point.verdict === '超限' ? '#7b241c' : '#0f4c75'"
          />
        </svg>
        <EmptyPanel v-else title="暂无可绘制的点据" description="录入点据后自动生成关系曲线。" compact />
        <p class="gb-hint">
          红点为偏差超限点据，橙点为复核后生效点据，灰色空心点为该点据的初测位置，曲线为按生效点据拟合的幂函数成果。
        </p>
      </el-card>
    </div>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑关系点据' : '新增关系点据'" width="560px" :close-on-click-modal="false">
      <el-form label-width="110px">
        <el-form-item label="所属测站" required>
          <el-select v-model="form.stationId" placeholder="选择测站" class="page__full">
            <el-option v-for="station in stationStore.stations" :key="station.id" :label="station.name" :value="station.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="定线号" required>
          <el-input v-model="form.lineNo" placeholder="如 A / B / C" maxlength="8" />
        </el-form-item>
        <el-form-item label="水位" required>
          <el-input-number v-model="form.stageM" :min="-50" :max="200" :step="0.01" :precision="2" controls-position="right" />
          <span class="page__unit">m</span>
        </el-form-item>
        <el-form-item label="流量" required>
          <el-input-number v-model="form.flowM3s" :min="0.01" :max="100000" :step="1" :precision="1" controls-position="right" />
          <span class="page__unit">m³/s</span>
        </el-form-item>
        <el-form-item label="测次号">
          <el-input v-model="form.measureNo" placeholder="如：2024-06-001" maxlength="32" />
        </el-form-item>
        <el-form-item label="点据时间">
          <el-date-picker v-model="form.measuredAt" type="datetime" value-format="YYYY-MM-DDTHH:mm" placeholder="选择时间" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存并重算' : '新增并定线' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="reviewDialogVisible"
      :title="reviewTarget && ratingStore.reviewOf(reviewTarget) ? '改录复核流量' : '补录复核流量'"
      width="520px"
      :close-on-click-modal="false"
    >
      <el-alert
        v-if="reviewTarget"
        type="info"
        :closable="false"
        show-icon
        :title="`点据：水位 ${reviewTarget.stageM.toFixed(2)} m，测次 ${reviewTarget.measureNo || '未标记'}，初测流量 ${reviewTarget.flowM3s.toFixed(1)} m³/s`"
        description="补录后该点据的曲线流量、偏差与结论按复核值重算，顶部统计与导出结论同步更新；同一次测流同一水位重复补录只保留最后一次。复核流量空着或为 0 视为放弃，点据回到初次比测结果。"
        class="page__review-alert"
      />
      <el-form label-width="110px" class="page__review-form">
        <el-form-item label="复核流量" required>
          <el-input-number
            v-model="reviewForm.flowM3s"
            :min="0"
            :max="100000"
            :step="1"
            :precision="1"
            :value-on-clear="undefined"
            controls-position="right"
            placeholder="空 / 0 表示放弃"
          />
          <span class="page__unit">m³/s</span>
        </el-form-item>
        <el-form-item label="复核人">
          <el-input v-model="reviewForm.reviewer" placeholder="如：整编复核" maxlength="16" />
        </el-form-item>
        <el-form-item label="复核日期">
          <el-date-picker v-model="reviewForm.reviewedAt" type="datetime" value-format="YYYY-MM-DDTHH:mm" placeholder="选择时间" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button
          v-if="reviewTarget && ratingStore.reviewOf(reviewTarget)"
          type="danger"
          plain
          :loading="reviewSubmitting"
          @click="abandonReview"
        >
          放弃复核
        </el-button>
        <el-button @click="reviewDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="reviewSubmitting" @click="submitReview">保存复核并重算</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  margin: 0 0 4px;
  font-size: 19px;
  color: #0f4c75;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.page__line-select {
  width: 120px;
}

.page__grid {
  display: grid;
  grid-template-columns: minmax(520px, 1.5fr) minmax(320px, 1fr);
  gap: 14px;
  align-items: start;
}

.page__chart-card {
  border: 1px solid #d8e4ec;
}

.page__chart {
  width: 100%;
  height: 240px;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #8194a2;
}

.page__full {
  width: 100%;
}

.page__review-alert {
  margin-bottom: 12px;
}

.page__review-form {
  margin-top: 4px;
}

.gb-cell-main {
  font-weight: 600;
  color: #1f3446;
}

.gb-cell-sub {
  margin-top: 2px;
  font-size: 12px;
  line-height: 18px;
  color: #8a99a6;
}

.gb-cell-sub__label {
  margin-right: 4px;
}

:deep(.gb-row-reviewed) {
  background-color: #fdf6ea !important;
}

@media (max-width: 1180px) {
  .page__grid {
    grid-template-columns: 1fr;
  }
}
</style>
