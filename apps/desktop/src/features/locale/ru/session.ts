/**
 * Russian UI copy for the session tools: the review panel, worktree chats,
 * "Continue in another harness" and continuing a terminal Pi session. Keys
 * are the English source strings; code, paths and branch names stay as is.
 */
export const sessionRu: Readonly<Record<string, string>> = {
  // Chat header, menu and sidebar.
  'Review changes': 'Ревью изменений',
  'Continue in another harness…': 'Продолжить в другом харнесе…',
  'in worktree {0}': 'в worktree {0}',

  // Review panel.
  Review: 'Ревью',
  'Refresh changes': 'Обновить изменения',
  'Close review': 'Закрыть ревью',
  'Resize the review panel': 'Изменить ширину панели ревью',
  'At commit {0}': 'На коммите {0}',
  detached: 'без ветки',
  Worktree: 'Worktree',
  'Could not read the changes': 'Не удалось прочитать изменения',
  'No git repository here': 'Здесь нет git-репозитория',
  'The review shows changes for chats in a git project folder. This chat works in a folder without git.':
    'Ревью показывает изменения для чатов в папке проекта с git. Этот чат работает в папке без git.',
  'Safe mode: the review is read-only.': 'Безопасный режим: ревью только для чтения.',
  'No changes': 'Изменений нет',
  'The working folder matches the last commit.': 'Рабочая папка совпадает с последним коммитом.',
  'Changed files': 'Изменённые файлы',
  Staged: 'В индексе',
  Changes: 'Изменения',
  'New files': 'Новые файлы',
  Modified: 'Изменён',
  Added: 'Добавлен',
  Deleted: 'Удалён',
  'Type changed': 'Изменён тип',
  'Marked to add': 'Помечен для добавления',
  Conflict: 'Конфликт',
  Submodule: 'Подмодуль',
  binary: 'двоичный',
  'Only the first 2000 changed files are listed.': 'Показаны только первые 2000 изменённых файлов.',
  '{0} files have names PiUI cannot show.': 'Файлов с именами, которые PiUI не может показать: {0}.',
  'Selected file': 'Выбранный файл',
  'Stage file': 'Добавить файл в индекс',
  'Unstage file': 'Убрать файл из индекса',
  'Move to Trash…': 'В корзину…',
  'Revert file…': 'Откатить файл…',
  Stage: 'В индекс',
  Unstage: 'Из индекса',
  'Revert…': 'Откатить…',
  'Comment…': 'Комментарий…',
  'Stage change {0}': 'Добавить в индекс изменение {0}',
  'Unstage change {0}': 'Убрать из индекса изменение {0}',
  'Revert change {0}…': 'Откатить изменение {0}…',
  'Comment on change {0}…': 'Прокомментировать изменение {0}…',
  'Comment on line {0}': 'Прокомментировать строку {0}',
  'Binary file, {0}. PiUI shows no content for it.': 'Двоичный файл, {0}. PiUI не показывает его содержимое.',
  'This change is too large to show here ({0}). Review it with git.':
    'Изменение слишком большое для показа здесь ({0}). Просмотрите его в git.',
  'A symbolic link. PiUI does not follow or move links.': 'Символическая ссылка. PiUI не переходит по ссылкам и не перемещает их.',
  'A submodule. Manage it with git directly.': 'Подмодуль. Управляйте им напрямую через git.',
  'This file has a merge conflict. Resolve it with your tools or ask the agent.':
    'В файле конфликт слияния. Разрешите его своими инструментами или попросите агента.',
  'Moved to the Trash': 'Перемещено в корзину',
  'Changes reverted': 'Изменения откачены',
  'Added to your message': 'Добавлено в сообщение',
  'Send it when you are ready.': 'Отправьте его, когда будете готовы.',

  // Revert confirmation.
  'Move {0} to the Trash?': 'Переместить {0} в корзину?',
  'Revert all changes in {0}?': 'Откатить все изменения в {0}?',
  'Revert this change in {0}?': 'Откатить это изменение в {0}?',
  'The file leaves the project folder and goes to the system Trash, where you can restore it. It was never committed.':
    'Файл уйдёт из папки проекта в системную корзину, откуда его можно восстановить. Он ни разу не был закоммичен.',
  'These changes will be lost.': 'Эти изменения будут потеряны.',
  'The file goes back to its staged version. Lines marked − come back; lines marked + are removed.':
    'Файл вернётся к версии из индекса. Строки с «−» вернутся, строки с «+» будут удалены.',
  'Binary file, {0}.': 'Двоичный файл, {0}.',
  'Binary file: the working copy ({0}) is replaced by the staged version.':
    'Двоичный файл: рабочая копия ({0}) будет заменена версией из индекса.',
  'This file is too large to show.': 'Файл слишком большой для показа.',
  'Move to Trash': 'В корзину',
  'Revert changes': 'Откатить изменения',

  // Line comments.
  'Comment for the agent on {0}': 'Комментарий агенту к {0}',
  Line: 'Строка',
  'removed {0}': 'удалённая {0}',
  '(empty line)': '(пустая строка)',
  'Note for the agent': 'Замечание для агента',
  'What should the agent do about this line?': 'Что агенту сделать с этой строкой?',
  'The line and your note go into the message box. Nothing is sent until you send it.':
    'Строка и ваше замечание попадут в поле сообщения. Ничего не отправится, пока вы не отправите сами.',
  'Add to message': 'Добавить в сообщение',

  // Worktree chats.
  Local: 'Локально',
  'Worktree · {0}': 'Worktree · {0}',
  'Same worktree · {0}': 'Тот же worktree · {0}',
  'Where the chat works: {0}': 'Где работает чат: {0}',
  'Work in the project folder': 'Работать в папке проекта',
  'Continue in the same worktree': 'Продолжить в том же worktree',
  'New worktree…': 'Новый worktree…',
  'New chat in a worktree': 'Новый чат в worktree',
  'The chat works in its own git worktree on a new branch, so your project folder stays as it is.':
    'Чат работает в собственном git worktree на новой ветке, а папка проекта остаётся как есть.',
  'New branch': 'Новая ветка',
  'Checking the repository…': 'Проверяю репозиторий…',
  Folder: 'Папка',
  'Starts from': 'Начинается с',
  'Uncommitted changes in the project folder are not included: the worktree starts from the last commit.':
    'Незакоммиченные изменения папки проекта не переносятся: worktree начинается с последнего коммита.',
  'PiUI creates the folder with git and runs no repository hooks. Removing the worktree later keeps the branch and its commits.':
    'PiUI создаёт папку через git и не запускает хуки репозитория. При удалении worktree ветка и её коммиты сохранятся.',
  'Use this worktree': 'Использовать этот worktree',
  Branch: 'Ветка',
  'Copy branch name': 'Скопировать имя ветки',
  'Branch name copied': 'Имя ветки скопировано',
  'Could not copy the branch name': 'Не удалось скопировать имя ветки',
  'Started from': 'Создан от',
  Removed: 'Удалён',
  Missing: 'Нет на месте',
  'The worktree was removed. The branch stays; this chat stays readable.':
    'Worktree удалён. Ветка сохранилась, история чата доступна для чтения.',
  'The worktree folder is missing. Remove the worktree to clean up.':
    'Папки worktree нет на месте. Удалите worktree, чтобы навести порядок.',
  'Remove worktree…': 'Удалить worktree…',
  'Remove this worktree?': 'Удалить этот worktree?',
  'Remove the worktree and lose its changes?': 'Удалить worktree и потерять его изменения?',
  'PiUI deletes the worktree folder:': 'PiUI удалит папку worktree:',
  'The branch {0} stays with its commits. Chats that work in this worktree stop; their history stays readable.':
    'Ветка {0} останется со своими коммитами. Чаты, работающие в этом worktree, остановятся; их история останется доступной.',
  'This worktree has {0} uncommitted changes.': 'В worktree незакоммиченных изменений: {0}.',
  'Removing it deletes them for good. They do not go to the Trash. Commit them on the branch first if you want to keep them.':
    'Удаление сотрёт их навсегда, в корзину они не попадут. Если хотите их сохранить, сначала закоммитьте их в ветку.',
  'Changes that will be lost': 'Изменения, которые будут потеряны',
  'I understand that these {0} changes will be lost': 'Я понимаю, что эти изменения ({0}) будут потеряны',
  'Remove worktree': 'Удалить worktree',
  'Remove and lose changes': 'Удалить и потерять изменения',
  'Worktree removed': 'Worktree удалён',
  'The branch {0} stays with its commits.': 'Ветка {0} осталась со своими коммитами.',

  // Where a chat came from.
  'Continued from': 'Продолжение чата',
  'This chat continues that one. Its history was not copied or converted.':
    'Этот чат продолжает тот. Его история не копировалась и не конвертировалась.',
  'A chat that is no longer in PiUI.': 'Чат, которого больше нет в PiUI.',
  'Started in the Pi terminal app. PiUI continues the same session file.':
    'Начат в терминальном Pi. PiUI продолжает тот же файл сессии.',

  // Continue in another harness.
  'Continuing "{0}" from {1}. Pick a harness and model, edit the message, then send it. The new chat links back; the original stays as it is.':
    'Продолжение «{0}» из {1}. Выберите харнес и модель, отредактируйте сообщение и отправьте его. Новый чат будет ссылаться на исходный, а исходный не изменится.',
  'I am continuing work from a {0} chat, "{1}".': 'Я продолжаю работу из чата {0} «{1}».',
  'The last request there was:': 'Последний запрос там был таким:',
  'The last answer began:': 'Последний ответ начинался так:',
  'Files changed so far:': 'Изменённые к этому моменту файлы:',
  '…and {0} more': '…и ещё {0}',
  'Please continue from here:': 'Продолжи отсюда:',

  // Continue a terminal Pi session.
  'Continue in PiUI': 'Продолжить в PiUI',
  'Continue this session in PiUI?': 'Продолжить эту сессию в PiUI?',
  'PiUI opens the same session file with Pi and adds this chat to the sidebar. It never rewrites the file; Pi appends new turns to it.':
    'PiUI откроет тот же файл сессии через Pi и добавит чат в боковую панель. PiUI никогда не переписывает файл; новые ходы дописывает сам Pi.',
  'Close it in the Pi terminal app first.': 'Сначала закройте её в терминальном Pi.',
  'The terminal and PiUI must not write to one session at the same time.':
    'Терминал и PiUI не должны одновременно писать в одну сессию.',

  // Session tool refusals (host-api/sessionToolErrors.ts).
  'Safe mode is on: PiUI does not change files, git or chats.':
    'Включён безопасный режим: PiUI не меняет файлы, git и чаты.',
  'Trust this project folder first.': 'Сначала доверьте эту папку проекта.',
  'This chat or file is no longer available. Refresh and try again.':
    'Этот чат или файл больше недоступен. Обновите и попробуйте снова.',
  'Check the request and try again.': 'Проверьте запрос и попробуйте снова.',
  'The project folder is unavailable.': 'Папка проекта недоступна.',
  'This changed while PiUI was working on it. Try again.': 'Это изменилось, пока PiUI с ним работал. Попробуйте снова.',
  'This folder is not a git repository.': 'Эта папка — не git-репозиторий.',
  'The repository has no commits yet. Make a first commit before creating a worktree.':
    'В репозитории ещё нет коммитов. Сделайте первый коммит, прежде чем создавать worktree.',
  "Choose a branch name with letters, digits, '.', '_', '-' and '/'.":
    "Выберите имя ветки из латинских букв, цифр и символов '.', '_', '-' и '/'.",
  'A branch with this name already exists. Choose another name.': 'Ветка с таким именем уже есть. Выберите другое имя.',
  'This changed since you reviewed it. Check it again before continuing.':
    'Это изменилось после вашего просмотра. Проверьте ещё раз, прежде чем продолжать.',
  'This action is not available here.': 'Здесь это действие недоступно.',
  'This change is too large for PiUI to show. Use git directly for it.':
    'Изменение слишком большое для показа в PiUI. Работайте с ним напрямую через git.',
  'Git was not found. Install git and make sure it is on PATH.': 'Git не найден. Установите git и добавьте его в PATH.',
  'Git refused this folder because it belongs to another account. Add it to safe.directory in your git settings.':
    'Git отказался работать с папкой: она принадлежит другой учётной записи. Добавьте её в safe.directory в настройках git.',
  'Another git command is using this repository. Try again in a moment.':
    'Этим репозиторием занята другая команда git. Попробуйте чуть позже.',
  'Git could not complete the operation.': 'Git не смог выполнить операцию.',
  'This system has no trash PiUI can use. The file was not changed.':
    'В этой системе нет корзины, которой может пользоваться PiUI. Файл не изменён.',
  'The file could not be moved to the trash and was left in place.':
    'Файл не удалось переместить в корзину; он остался на месте.',
  "This chat's worktree was removed. Its history stays readable; start a new chat to keep working.":
    'Worktree этого чата удалён. История доступна для чтения; чтобы продолжить работу, начните новый чат.',
  "This chat's worktree folder is missing or no longer belongs to the project's repository.":
    'Папки worktree этого чата нет или она больше не относится к репозиторию проекта.',
  'This session was written moments ago and may still be open in the Pi terminal app. Close it there, then try again.':
    'В эту сессию писали только что, и она может быть ещё открыта в терминальном Pi. Закройте её там и попробуйте снова.',
  'PiUI could not save this change. Nothing was lost.': 'PiUI не смог сохранить это изменение. Ничего не потеряно.',
  'The harness could not start. Its saved history has not been removed.':
    'Харнес не запустился. Его сохранённая история не удалена.',
  'The operation could not be completed.': 'Операцию не удалось выполнить.',
  'Resolve this conflict with your tools or the agent first.':
    'Сначала разрешите этот конфликт своими инструментами или с помощью агента.',
  'Manage submodules with git directly.': 'Управляйте подмодулями напрямую через git.',
  'This change can only be handled as a whole file.': 'С этим изменением можно работать только целым файлом.',
  'Stage a new file as a whole.': 'Новый файл добавляется в индекс целиком.',
  'Move a new file to the trash as a whole.': 'Новый файл перемещается в корзину целиком.',
  'PiUI moves only regular files to the trash. Remove this link yourself.':
    'PiUI перемещает в корзину только обычные файлы. Удалите эту ссылку сами.',
  'Unstage this new file first, then move it to the trash.':
    'Сначала уберите этот новый файл из индекса, затем переместите его в корзину.',
  'This change is too large to show, so PiUI does not revert it.':
    'Изменение слишком большое для показа, поэтому PiUI его не откатывает.',
  'Unstage these changes first, then revert them.': 'Сначала уберите эти изменения из индекса, затем откатите их.',
  'Worktrees are for project folders. Personal chats have no repository.':
    'Worktree создаются для папок проектов. У личных чатов нет репозитория.',
  'This chat does not run in a worktree.': 'Этот чат не работает в worktree.',
  'That chat does not run in a worktree.': 'Тот чат не работает в worktree.',
  'The chat this one continues is no longer available.': 'Чат, который продолжает этот, больше недоступен.',
};
