/** Russian UI copy for app updates and release information. Keys are the English source strings. */
export const releaseRu: Readonly<Record<string, string>> = {
  // Settings → About: updates
  'Updates': 'Обновления',
  'Check for updates': 'Проверить обновления',
  'Checking for updates…': 'Проверка обновлений…',
  'Downloading PiUI {0}…': 'Загрузка PiUI {0}…',
  'Installing PiUI {0}. PiUI will restart.': 'Установка PiUI {0}. PiUI перезапустится.',
  'PiUI is restarting to finish the update.': 'PiUI перезапускается, чтобы завершить обновление.',
  'The update did not start. PiUI stopped its agents, so restart it to continue.':
    'Обновление не запустилось. PiUI уже остановил агентов — перезапустите его, чтобы продолжить.',
  'PiUI {0} is available.': 'Доступна версия PiUI {0}.',
  'PiUI is up to date. Last checked {0}.': 'Установлена последняя версия PiUI. Последняя проверка: {0}.',
  'The last check did not finish ({0}).': 'Последняя проверка не завершилась ({0}).',
  'Not checked yet.': 'Проверки ещё не было.',
  'Restart PiUI': 'Перезапустить PiUI',
  'This release has no notes.': 'У этого выпуска нет описания изменений.',
  'Download progress': 'Ход загрузки',
  'Download and restart': 'Загрузить и перезапустить',
  'Check for updates automatically': 'Проверять обновления автоматически',
  'When PiUI starts and once a day. Nothing installs without your confirmation.':
    'При запуске PiUI и раз в день. Без вашего подтверждения ничего не устанавливается.',
  'PiUI installs an update only after its signature matches the key built into this version. Checks contact {0}.':
    'PiUI устанавливает обновление, только если его подпись совпадает с ключом, встроенным в эту версию. Для проверки PiUI обращается к {0}.',
  'Install PiUI {0}?': 'Установить PiUI {0}?',
  'PiUI downloads the update and checks its signature. Then it stops running chats and pipeline steps as it does when you quit, installs the update and starts again.':
    'PiUI загрузит обновление и проверит его подпись. Затем остановит идущие чаты и шаги пайплайнов, как при выходе, установит обновление и запустится снова.',
  'Finish or copy any message you are writing first. Interrupted pipeline steps can be reviewed in Runs after the restart.':
    'Сначала допишите или скопируйте сообщение, которое набираете. Прерванные шаги пайплайнов можно будет проверить в разделе «Запуски» после перезапуска.',
  // Update failures (host codes)
  'The update request was not valid.': 'Некорректный запрос обновления.',
  'Updates are not set up in this build.': 'В этой сборке обновления не настроены.',
  'An update check or install is already running.': 'Проверка или установка обновления уже идёт.',
  'This update is no longer offered. Check for updates again.': 'Это обновление больше не предлагается. Проверьте обновления ещё раз.',
  'Could not reach the update server. Check your connection and try again.':
    'Не удалось связаться с сервером обновлений. Проверьте подключение и попробуйте ещё раз.',
  'The update information could not be read. Try again later.': 'Не удалось прочитать сведения об обновлении. Попробуйте позже.',
  'This update has no package for this system.': 'Для этой системы в обновлении нет пакета.',
  'Could not check for updates. Try again later.': 'Не удалось проверить обновления. Попробуйте позже.',
  'The update could not be downloaded. Nothing was installed.': 'Не удалось загрузить обновление. Ничего не установлено.',
  'The update’s signature did not match PiUI’s signing key, so it was not installed.':
    'Подпись обновления не совпала с ключом подписи PiUI, поэтому оно не установлено.',
  'The update could not be installed.': 'Не удалось установить обновление.',
  'Could not save this preference. The previous choice is kept.': 'Не удалось сохранить настройку. Оставлен прежний выбор.',
  'The update action could not be completed.': 'Не удалось выполнить действие с обновлением.',
  // Notice after an automatic check
  'PiUI {0} is available': 'Доступна версия PiUI {0}',
  'Read what changed and install it from Settings → About.': 'Что изменилось и как установить — в разделе «Настройки → О программе».',
  'View update': 'Посмотреть',
};
