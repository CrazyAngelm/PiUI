import { expect, it } from 'vitest';
import { APPROVAL_FIELD_ISSUES } from '../../../host-api/approvalForms';
import { translate } from '../language';

it('translates the MCP form request copy, including every field problem', () => {
  for (const message of [
    ...Object.values(APPROVAL_FIELD_ISSUES),
    'MCP server {0}',
    'Requested values',
    'Accept',
    'Decline',
    'No answer',
    '{0} or more.',
    '{0} or less.',
    'This request needs a value PiUI cannot show, so it can only be declined.',
    'Some optional values cannot be entered here and are left empty.',
  ]) {
    expect(translate(message, 'ru'), message).not.toBe(message);
  }
});
