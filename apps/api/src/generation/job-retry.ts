export function retryPreparation(row: { optimization_mode?: string; prompt_optimization_id?: string | null; final_prompt?: string | null; template_instruction_snapshot?: string | null }) {
  if (row.optimization_mode !== 'enabled' || !row.prompt_optimization_id) return { phase: 'image_generating', resetOptimization: false }
  if (row.final_prompt) return { phase: 'image_generating', resetOptimization: false }
  return { phase: row.template_instruction_snapshot ? 'template_selected' : 'template_selecting', resetOptimization: true }
}
