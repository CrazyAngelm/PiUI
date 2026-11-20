/**
 * Russian names of the native reasoning levels. Keys are `reasoning:<level id>`:
 * the bare ids are shared with other screens (`none` is "нет" in sub-pipelines).
 * Read through `reasoningLabel`, never by hand.
 */
export const reasoningRu: Readonly<Record<string, string>> = {
  'reasoning:off': 'Отключено',
  'reasoning:none': 'Без рассуждений',
  'reasoning:minimal': 'Минимально',
  'reasoning:low': 'Низкое',
  'reasoning:medium': 'Среднее',
  'reasoning:high': 'Высокое',
  'reasoning:xhigh': 'Очень высокое',
  'reasoning:max': 'Максимальное',
  'reasoning:ultra': 'Ультра',
};
