/**
 * Barrel for the design-system primitives: one import surface for every screen.
 *
 * Layering rule for callers: these components know about tokens, states and
 * accessibility only — no feature logic, no data fetching, no `features/*`
 * imports. Anything that needs a store or an endpoint belongs one level up.
 */

// --- Actions -----------------------------------------------------------------
export { Button, IconButton, buttonVariants, ghostIconButtonVariants } from './button'
export type { ButtonProps, ButtonSize, ButtonVariant, ButtonVariantProps, IconButtonProps } from './button'

// --- Display -----------------------------------------------------------------
export { Alert } from './alert'
export type { AlertProps, AlertTone } from './alert'

export { Avatar } from './avatar'
export type { AvatarProps, AvatarSize, AvatarStatus } from './avatar'

export { Badge } from './badge'
export type { BadgeProps, BadgeTone, BadgeVariant } from './badge'

export { Card, CardBody, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './card'
export type {
  CardBodyProps,
  CardContentProps,
  CardDensity,
  CardDescriptionProps,
  CardFooterProps,
  CardHeaderProps,
  CardProps,
  CardTitleProps,
  CardVariant,
} from './card'

export { Divider } from './divider'
export type { DividerProps } from './divider'

export { EmptyState } from './empty-state'
export type { EmptyStateProps } from './empty-state'

export { PageHeader } from './page-header'
export type { PageHeaderProps } from './page-header'

export { SectionHeader } from './section-header'
export type { SectionHeaderProps } from './section-header'

// --- Forms -------------------------------------------------------------------
export { Field, FieldGroup, FormField, useFieldContext, useFormFieldContext } from './field'
export type { FieldContextValue, FieldGroupProps, FieldProps } from './field'

export { Input, controlClasses, controlHeight, controlSurface, useControlWiring } from './input'
export type { ControlSize, ControlVariant, InputProps } from './input'

export { Textarea } from './textarea'
export type { TextareaProps } from './textarea'

export { Select } from './select'
export type { SelectProps } from './select'

export { Checkbox } from './checkbox'
export type { CheckboxProps } from './checkbox'

export { Switch } from './switch'
export type { SwitchProps } from './switch'

// --- Navigation / overlays ---------------------------------------------------
export { SegmentedControl } from './segmented-control'
export type { SegmentedControlItem, SegmentedControlProps } from './segmented-control'

export { Tabs } from './tabs'
export type { TabItem, TabsProps } from './tabs'

export { Dialog } from './dialog'
export type { DialogProps, DialogSize } from './dialog'

export { DropdownMenu } from './dropdown-menu'
export type { DropdownMenuItem, DropdownMenuProps } from './dropdown-menu'

// --- Feedback ----------------------------------------------------------------
export { ToastProvider, useToast } from './toast'
export type { ToastApi, ToastOptions, ToastTone } from './toast'

export { Spinner } from './spinner'
export type { SpinnerProps } from './spinner'

export { Progress } from './progress'
export type { ProgressProps } from './progress'

export { Skeleton, SkeletonRow, SkeletonText, SkeletonTile } from './skeleton'
export type { SkeletonProps, SkeletonRowProps, SkeletonTextProps, SkeletonTileProps } from './skeleton'

// --- Data display ------------------------------------------------------------
export {
  DataTable,
  Table,
  TableBody,
  TableCell,
  TableFrame,
  TableHead,
  TableHeadCell,
  TableHeader,
  TableRow,
  TableSkeletonRow,
  TableStateRow,
} from './table'
export type {
  TableBodyProps,
  TableCellProps,
  TableDensity,
  TableFrameProps,
  TableHeadCellProps,
  TableHeaderProps,
  TableProps,
  TableRowProps,
  TableSkeletonCell,
  TableSkeletonRowProps,
  TableStateRowProps,
} from './table'

export { Stepper } from './stepper'
export type { StepperProps, StepperStep } from './stepper'

// --- Shared size maps / interaction classes ----------------------------------
export { controlMinHeight, controlSquare, iconSize, iconSlot } from './size'
export type { ControlMinHeightSize, ControlSquareSize, IconSize } from './size'

export {
  colourTransition,
  focusRing,
  focusRingPeer,
  motionPress,
  outlineHover,
  peerOutlineHover,
  pressable,
  rowHover,
} from './interaction'

// --- Theme -------------------------------------------------------------------
// Owned by the foundation slice; re-exported so `@/shared/components/ui` stays the
// single path a screen needs.
export * from './theme-toggle'
