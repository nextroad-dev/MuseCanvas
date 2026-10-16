/**
 * Shared UI primitives for web, one import surface for every screen.
 *
 * Layering rule for callers: these components know about tokens, states and
 * accessibility only — no feature logic, no data fetching, no `features/*`
 * imports. Anything that needs a store or an endpoint belongs one level up.
 */

export { Alert } from './alert'
export type { AlertProps, AlertTone } from './alert'

export { Avatar } from './avatar'
export type { AvatarProps, AvatarSize, AvatarStatus } from './avatar'

export { Badge, BadgeCount, BadgeDot } from './badge'
export type { BadgeCountProps, BadgeDotProps, BadgeProps, BadgeTone, BadgeVariant } from './badge'

// `buttonVariants` is also exported by `./button`; the recipe module is the one a
// server component can call, so it is listed here for the client-side imports.
export { Button, IconButton, buttonVariants, ghostIconButtonVariants } from './button'
export type { ButtonProps, ButtonSize, ButtonVariant, ButtonVariantProps, IconButtonProps } from './button'

export { Card, CardBody, CardDescription, CardFooter, CardHeader, CardTitle, StatCard } from './card'
export type { CardProps, CardTitleProps, StatCardProps } from './card'

export { Divider } from './divider'
export type { DividerProps } from './divider'

export { DropdownMenu } from './dropdown-menu'
export type { DropdownMenuItem, DropdownMenuProps } from './dropdown-menu'

export { EmptyState } from './empty-state'
export type { EmptyStateProps, EmptyStateVariant } from './empty-state'

export { FieldGroup, FormField, useFormFieldContext } from './field'
export type { FormFieldContextValue, FormFieldProps, FieldGroupProps } from './field'

export { Input, Textarea, controlClasses, controlHeight, controlSurface } from './input'
export type { ControlSize, ControlVariant, InputProps, TextareaProps } from './input'

// Token → utility maps for repeated sizes (icon boxes, square controls). See the
// module header for why these are maps and not inline arbitrary values.
export { controlMinHeight, controlSquare, iconSize, iconSlot } from './size'
export type { ControlSquareSize, IconSize } from './size'

export { PageHeader } from './page-header'
export type { PageHeaderProps } from './page-header'

export { Pagination } from './pagination'
export type { PaginationProps } from './pagination'

export { Progress } from './progress'
export type { ProgressProps } from './progress'

export { Radio, RadioGroup } from './radio'
export type { RadioProps, RadioGroupProps } from './radio'

export { Select } from './select'
export type { SelectProps } from './select'

export { SegmentedControl } from './segmented-control'
export type { SegmentedControlProps, SegmentedControlItem } from './segmented-control'

export { Spinner } from './spinner'
export type { SpinnerProps } from './spinner'

export { SectionHeader } from './section-header'
export type { SectionHeaderProps } from './section-header'

export { Stepper } from './stepper'
export type { StepperProps, StepperStep } from './stepper'

export { Tabs } from './tabs'
export type { TabItem, TabsProps } from './tabs'

export {
  DataTable,
  TableBody,
  TableCell,
  TableFrame,
  TableHead,
  TableHeadCell,
  TableRow,
  TableSkeletonRow,
  TableStateRow,
} from './table'
export type {
  DataTableProps,
  TableBodyProps,
  TableCellProps,
  TableFrameProps,
  TableHeadCellProps,
  TableHeadProps,
  TableRowProps,
  TableSkeletonCell,
  TableSkeletonRowProps,
  TableStateRowProps,
} from './table'

export { FileDropZone, formatFileSize } from './dropzone'
export type { DropZoneFile, DropZoneFileStatus, FileDropZoneProps } from './dropzone'

// Pre-existing primitives, re-exported so `@/shared/components/ui` is the only
// path a screen needs. Owned elsewhere — extend here only when adding a file.
export * from './checkbox'
export * from './dialog'
export * from './radio'
export * from './skeleton'
export * from './switch'
export * from './theme-toggle'
export * from './toast'
