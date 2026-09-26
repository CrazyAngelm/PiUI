/** Russian UI copy for harness setup, sign-in and approvals. Keys are the English source strings. */
export const harnessesRu: Readonly<Record<string, string>> = {
  // MCP form requests (Codex MCP elicitations) in approval cards.
  'MCP server {0}': 'MCP-сервер {0}',
  'Requested values': 'Запрошенные значения',
  'Accept': 'Принять',
  'Decline': 'Отклонить',
  'No answer': 'Без ответа',
  'From {0} to {1}.': 'От {0} до {1}.',
  '{0} or more.': 'Не меньше {0}.',
  '{0} or less.': 'Не больше {0}.',
  'This request needs a value PiUI cannot show, so it can only be declined.':
    'Запрос требует значение, которое PiUI не умеет показать, поэтому его можно только отклонить.',
  'Some optional values cannot be entered here and are left empty.':
    'Некоторые необязательные значения здесь ввести нельзя, они останутся пустыми.',
  'Fill in this field.': 'Заполните это поле.',
  'Enter at least {0} characters.': 'Введите не меньше {0} символов.',
  'Enter at most {0} characters.': 'Введите не больше {0} символов.',
  'Enter an email address.': 'Введите адрес электронной почты.',
  'Enter a full address, such as https://example.com.': 'Введите полный адрес, например https://example.com.',
  'Enter a date as YYYY-MM-DD.': 'Введите дату в формате ГГГГ-ММ-ДД.',
  'Enter a date and time with a time zone, such as 2026-09-27T10:00:00Z.':
    'Введите дату и время с часовым поясом, например 2026-09-27T10:00:00Z.',
  'Enter a number.': 'Введите число.',
  'Enter a whole number.': 'Введите целое число.',
  'Enter {0} or more.': 'Введите {0} или больше.',
  'Enter {0} or less.': 'Введите {0} или меньше.',
  'Choose one of the options.': 'Выберите один из вариантов.',

  // Claude Code sign-in: run panel.
  'Claude Code is not signed in with your Claude subscription, so this step did not start. Run `claude` in a terminal and use /login, then run this step again.':
    'Claude Code не вошёл по вашей подписке Claude, поэтому шаг не запускался. Выполните `claude` в терминале, войдите через /login и запустите шаг снова.',
};
