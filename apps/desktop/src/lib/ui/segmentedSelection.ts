/**
 * Selection rule of a segmented control: exactly one option is always selected.
 *
 * The headless toggle group underneath reports "" when the active item is
 * pressed again (mouse, Space or Enter). That is not a selection, so it must
 * never reach the bound value.
 *
 * Returns the option value to select, or `null` when nothing should change:
 * the active option was pressed again, the group reported an empty value, or
 * the value is not one of the options.
 */
export function nextSegmentedValue<T extends string>(
  current: T,
  requested: string,
  options: readonly { value: T }[]
): T | null {
  if (requested === '' || requested === current) return null;
  const match = options.find((option) => option.value === requested);
  return match === undefined ? null : match.value;
}
