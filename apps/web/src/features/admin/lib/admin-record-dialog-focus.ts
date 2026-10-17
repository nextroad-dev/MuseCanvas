interface AdminFocusTarget {
  isConnected: boolean
  focus: (options?: FocusOptions) => void
}

/** Switch content focus without closing/remounting the modal's focus and scroll scope. */
export function focusAdminRecordDialogMode(
  confirming: boolean,
  cancel: AdminFocusTarget | null,
  previousDetailFocus: AdminFocusTarget | null,
  detailPanel: AdminFocusTarget | null,
) {
  const target = confirming ? cancel : previousDetailFocus?.isConnected ? previousDetailFocus : detailPanel
  target?.focus({ preventScroll: true })
}

/** Keep the shared Dialog's restored trigger; fall back if it was removed or is no longer focusable. */
export function restoreAdminRecordListFocus(trigger: AdminFocusTarget | null, list: AdminFocusTarget | null, focusWasRestored: boolean) {
  if ((!trigger?.isConnected || !focusWasRestored) && list?.isConnected) list.focus({ preventScroll: true })
}
