/** Russian UI copy for chat attachments, mentions and review. Keys are the English source strings. */
export const chatRu: Readonly<Record<string, string>> = {
  // Attachments: paperclip, paste and drag and drop.
  'Attach images or files': 'Прикрепить изображения или файлы',
  'Attached images': 'Прикреплённые изображения',
  'Preview of {0}': 'Превью: {0}',
  'Remove {0}': 'Убрать {0}',
  'Image': 'Изображение',
  'Drop images or files to attach': 'Перетащите изображения или файлы, чтобы прикрепить',
  'Remove the images to send this message.': 'Уберите изображения, чтобы отправить сообщение.',
  'This harness does not accept images in PiUI.': 'Этот харнес не принимает изображения в PiUI.',
  'The current model does not accept images.': 'Текущая модель не принимает изображения.',
  'Codex sends images to models that accept image input.': 'Codex передаёт изображения моделям, которые их принимают.',
  'Claude Code receives images as image content.': 'Claude Code получает изображения как изображения.',
  'Pi sends images to models that declare image input.': 'Pi передаёт изображения моделям, которые заявляют их поддержку.',
  'Hermes receives images when its ACP agent declares image input.':
    'Hermes получает изображения, если его ACP-агент заявляет их поддержку.',
  'Prime Agent accepts text only in PiUI.': 'Prime Agent принимает в PiUI только текст.',
  // What happened to files that were not attached.
  '{0} was not attached. {1}': '{0}: не прикреплено. {1}',
  '{0} was not attached. A message can carry at most {1} images.':
    '{0}: не прикреплено. К сообщению можно прикрепить не больше {1} изображений.',
  '{0} was not attached. Only images can be pasted or dropped here; use the paperclip or @ to reference other files by path.':
    '{0}: не прикреплено. Вставить или перетащить сюда можно только изображения; другие файлы укажите по пути через скрепку или @.',
  'Folders cannot be attached.': 'Папки прикрепить нельзя.',
  'Images must be 5 MB or smaller.': 'Изображение должно быть не больше 5 МБ.',
  'The file could not be read.': 'Не удалось прочитать файл.',
  'Only PNG, JPEG, GIF and WebP images can be attached.': 'Прикрепить можно только изображения PNG, JPEG, GIF и WebP.',
  'Too many files at once. Attach at most 10 at a time.': 'Слишком много файлов сразу. Прикрепляйте не больше 10 за раз.',
  // Path references (non-image files) need a visible confirmation.
  'Reference this file by its path?': 'Указать этот файл по пути?',
  'Reference {0} files by their paths?': 'Указать файлы по путям ({0})?',
  'The agent reads referenced files with its own tools. PiUI does not upload, copy or attach them.':
    'Агент прочитает эти файлы своими инструментами. PiUI их не загружает, не копирует и не прикрепляет.',
  'File references': 'Ссылки на файлы',
  'Outside the project folder': 'Вне папки проекта',
  'Insert references': 'Вставить ссылки',
  // `/` commands, `@` files and `$` skills.
  'Reply, type / for commands or @ to mention a file…': 'Ответьте, введите / для команд или @, чтобы упомянуть файл…',
  'Project files': 'Файлы проекта',
  'Loading project files…': 'Загрузка файлов проекта…',
  'No matching files': 'Подходящих файлов нет',
  'No matches': 'Ничего не найдено',
  'Trust this project to mention its files.': 'Чтобы упоминать файлы проекта, доверьте ему.',
  'extension': 'расширение',
  'prompt': 'шаблон',
  'skill': 'навык',
  // Host refusals and outbox notes.
  'This harness or its current model does not accept images. Remove the images or switch models.':
    'Этот харнес или его текущая модель не принимает изображения. Уберите изображения или смените модель.',
  'An attached image is no longer available. Attach it again.': 'Прикреплённое изображение больше недоступно. Прикрепите его снова.',
  'The project files could not be listed.': 'Не удалось получить список файлов проекта.',
  'The dropped files are no longer available. Drop them again.': 'Перетащенные файлы больше недоступны. Перетащите их снова.',
  'The harness or its current model does not accept images. Your message is still queued; remove it or switch to a model that accepts images.':
    'Харнес или его текущая модель не принимает изображения. Сообщение осталось в очереди: уберите его или выберите модель с поддержкой изображений.',
  'An attached image is no longer available. Remove this message and attach the image again.':
    'Прикреплённое изображение больше недоступно. Уберите это сообщение и прикрепите изображение снова.',
};
