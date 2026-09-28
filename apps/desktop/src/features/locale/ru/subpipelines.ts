/** Russian UI copy for sub-pipelines (orchestration v6.7, ADR-042). Keys are the English source strings. */
export const subpipelinesRu: Readonly<Record<string, string>> = {
  // Editor: adding and showing a sub-pipeline step.
  'Sub-pipelines': 'Вложенные пайплайны',
  'Sub-pipeline': 'Вложенный пайплайн',
  'Untitled sub-pipeline': 'Вложенный пайплайн без имени',
  'Unknown pipeline': 'Неизвестный пайплайн',
  'No pipeline chosen': 'Пайплайн не выбран',
  In: 'Вход',
  Out: 'Выход',
  none: 'нет',
  'last step text': 'текст последнего шага',
  'Reading the pipeline…': 'Чтение пайплайна…',
  'Choose a saved pipeline to run': 'Выберите сохранённый пайплайн для запуска',
  'Runs a saved pipeline as one step': 'Запускает сохранённый пайплайн как один шаг',
  Pipeline: 'Пайплайн',
  'Open pipeline {0}': 'Открыть пайплайн {0}',
  Open: 'Открыть',
  'Open pipeline': 'Открыть пайплайн',
  'Step name': 'Название шага',

  // Inspector of a sub-pipeline step.
  'Runs a saved pipeline of this project as its own run, with its own agents, approvals and history. This step finishes when that run finishes.':
    'Запускает сохранённый пайплайн этого проекта отдельным запуском, со своими агентами, одобрениями и историей. Шаг завершается, когда завершается этот запуск.',
  'Pipeline to run': 'Какой пайплайн запускать',
  'No other saved pipelines': 'Других сохранённых пайплайнов нет',
  'Choose a pipeline': 'Выберите пайплайн',
  'Inputs of {0}': 'Входные данные «{0}»',
  'This pipeline asks for no inputs.': 'Этот пайплайн не запрашивает входных данных.',
  'Value from': 'Значение из',
  'Default: {0}': 'По умолчанию: {0}',
  'Not set': 'Не задано',
  'Fixed value': 'Фиксированное значение',
  'Run input of this pipeline': 'Входные данные этого пайплайна',
  'Result of a connected step': 'Результат связанного шага',
  'Fixed value for {0}': 'Фиксированное значение для «{0}»',
  'Run input for {0}': 'Входные данные для «{0}»',
  'Source step for {0}': 'Шаг-источник для «{0}»',
  'Not connected': 'Не связан',
  'Result field for {0}': 'Поле результата для «{0}»',
  'Whole result text': 'Весь текст результата',
  'Remove mapping {0}': 'Удалить сопоставление {0}',
  Result: 'Результат',
  'This pipeline declares no outputs, so this step returns the text of its last finished step. Declare outputs on its Output block to return named fields.':
    'У этого пайплайна нет объявленных выходов, поэтому шаг вернёт текст его последнего завершённого шага. Объявите выходы в его блоке «Выход», чтобы возвращать именованные поля.',
  'Its outputs become this step’s result fields: {0}.': 'Его выходы становятся полями результата этого шага: {0}.',
  'Use the pipeline’s outputs as result fields': 'Взять выходы пайплайна как поля результата',
  'The sub-pipeline’s declared outputs, checked when its run finishes. Without fields, the text of its last finished step is passed on.':
    'Объявленные выходы вложенного пайплайна, проверяются по завершении его запуска. Без полей передаётся текст его последнего завершённого шага.',

  // The Output block.
  Output: 'Выход',
  Outputs: 'Выходы',
  'No declared outputs': 'Выходы не объявлены',
  'Close output settings': 'Закрыть настройки выхода',
  'What this pipeline returns when another pipeline runs it as a sub-pipeline. Without outputs, it returns the text of its last finished step.':
    'Что возвращает этот пайплайн, когда другой пайплайн запускает его как вложенный. Без выходов возвращается текст его последнего завершённого шага.',
  'Output name': 'Имя выхода',
  Type: 'Тип',
  'Remove output {0}': 'Удалить выход {0}',
  'From step': 'Из шага',
  Value: 'Значение',
  'Missing step': 'Шаг отсутствует',
  'not declared': 'не объявлено',
  'Add output': 'Добавить выход',

  // Graph and system-file issues.
  'Choose which saved pipeline this sub-pipeline step runs.': 'Выберите, какой сохранённый пайплайн запускает этот шаг.',
  'The pipeline this sub-pipeline step runs no longer exists.': 'Пайплайна, который запускает этот шаг, больше нет.',
  'A pipeline cannot run itself as a sub-pipeline.': 'Пайплайн не может запускать сам себя как вложенный.',
  'These sub-pipelines run each other in a loop.': 'Эти вложенные пайплайны запускают друг друга по кругу.',
  'Map every required input of the sub-pipeline that has no default.':
    'Задайте каждое обязательное входное значение вложенного пайплайна, у которого нет значения по умолчанию.',
  'A mapped input is not declared by the sub-pipeline.': 'Вложенный пайплайн не объявляет одно из сопоставленных входных значений.',
  'A fixed value does not match the type of its sub-pipeline input.': 'Фиксированное значение не соответствует типу входа вложенного пайплайна.',
  'A sub-pipeline input uses a run input this pipeline does not declare.':
    'Вход вложенного пайплайна берёт входные данные, которые этот пайплайн не объявляет.',
  'A sub-pipeline input can only use the result of a step connected directly before it.':
    'Вход вложенного пайплайна может брать результат только шага, связанного с ним напрямую перед ним.',
  'A sub-pipeline input uses a result field the source step does not declare.':
    'Вход вложенного пайплайна берёт поле результата, которое шаг-источник не объявляет.',
  'A sub-pipeline input gets a value of a different type.': 'Вход вложенного пайплайна получает значение другого типа.',
  'A sub-pipeline step maps its inputs itself; remove its input mappings.':
    'Шаг вложенного пайплайна сам сопоставляет свои входы; удалите его привязки входных данных.',
  'Outputs need unique names (a lowercase letter, then letters, digits or underscores), at most 32, and a step with a declared field or its whole text.':
    'Выходам нужны уникальные имена (строчная буква, затем буквы, цифры или подчёркивания), не более 32, и шаг с объявленным полем или весь его текст.',
  'System files cannot hold sub-pipeline steps or declared outputs yet. Remove them to export this pipeline or save it as a template.':
    'Системные файлы пока не могут содержать вложенные пайплайны и объявленные выходы. Удалите их, чтобы экспортировать пайплайн или сохранить его как шаблон.',

  // Runs.
  'Sub-pipeline of run': 'Вложенный пайплайн запуска',
  'Open parent run {0}': 'Открыть родительский запуск {0}',
  'level {0} of {1}': 'уровень {0} из {1}',
  'child run': 'дочерний запуск',
  'Status of the child run': 'Состояние дочернего запуска',
  'Child run: {0}': 'Дочерний запуск: {0}',
  'Child run': 'Дочерний запуск',
  'Open child run': 'Открыть дочерний запуск',
  'Inputs of the sub-pipeline': 'Входные данные вложенного пайплайна',
  'No inputs are mapped; the sub-pipeline uses its defaults.': 'Входы не сопоставлены; вложенный пайплайн использует свои значения по умолчанию.',
  'Run input {0}': 'Входные данные {0}',
  'Result of {0}': 'Результат шага «{0}»',
  'PiUI could not confirm how the sub-pipeline ended. Check its child run, then record an operator assertion. It reconciles the journal only.':
    'PiUI не удалось подтвердить, чем закончился вложенный пайплайн. Проверьте его дочерний запуск, затем запишите утверждение оператора. Оно только сверяет журнал.',
  'Sub-pipeline of #{0}': 'Вложен в #{0}',

  // Failure codes of sub-pipeline steps.
  'The pipeline this step runs no longer exists or cannot start, so nothing ran.':
    'Пайплайна, который запускает этот шаг, больше нет или его нельзя запустить, поэтому ничего не выполнялось.',
  'This sub-pipeline would run a pipeline that is already running above it, so nothing ran.':
    'Этот вложенный пайплайн запустил бы пайплайн, который уже выполняется выше по цепочке, поэтому ничего не выполнялось.',
  'Sub-pipelines are nested too deeply (at most 4 levels), so nothing ran.':
    'Вложенные пайплайны вложены слишком глубоко (не более 4 уровней), поэтому ничего не выполнялось.',
  'A value for the sub-pipeline’s inputs does not match what it asks for, so nothing ran.':
    'Значение для входов вложенного пайплайна не соответствует тому, что он запрашивает, поэтому ничего не выполнялось.',
  'A result this sub-pipeline needs as input was not available, so nothing ran.':
    'Результат, нужный вложенному пайплайну как вход, был недоступен, поэтому ничего не выполнялось.',
  'The sub-pipeline’s run failed. Open the child run to see which step.':
    'Запуск вложенного пайплайна завершился ошибкой. Откройте дочерний запуск, чтобы увидеть, на каком шаге.',
  'The sub-pipeline’s run was cancelled.': 'Запуск вложенного пайплайна был отменён.',
  'The sub-pipeline finished, but a declared output had no value.':
    'Вложенный пайплайн завершился, но у одного из объявленных выходов не оказалось значения.',
};
