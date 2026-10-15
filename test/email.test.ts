import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emailProvider, sendTransactionalEmail } from '../src/auth/email';
import type { Bindings, EmailMessageBuilder } from '../src/types';

function bindings(overrides: Record<string, unknown> = {}): Bindings {
  return { AUTH_FROM_EMAIL: 'noreply@mail.aismallbizguru.com', ...overrides } as unknown as Bindings;
}
const message = { to: 'user@example.com', subject: 'Subject', text: 'plain body', html: '<p>rich body</p>' };

// Records what the Worker's send_email binding received and returns the documented
// { messageId } result unless a failure is configured.
function fakeBinding(fail?: () => never) {
  const sent: EmailMessageBuilder[] = [];
  const binding = {
    send: async (mail: EmailMessageBuilder) => {
      if (fail) fail();
      sent.push(mail);
      return { messageId: '<test@mail.aismallbizguru.com>' };
    },
  };
  return { sent, binding };
}

describe('transactional email service', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('sends HTML and text through the Cloudflare Email Sending binding with a structured sender', async () => {
    const { sent, binding } = fakeBinding();
    await sendTransactionalEmail(bindings({ AUTH_FROM_NAME: 'CFLab', EMAIL: binding }), message);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      from: { email: 'noreply@mail.aismallbizguru.com', name: 'CFLab' },
      to: 'user@example.com',
      subject: 'Subject',
      text: 'plain body',
      html: '<p>rich body</p>',
    });
  });

  it('sends a bare address when no display name is configured or the name is unsafe', async () => {
    for (const name of [undefined, '', 'CFLab\r\nBcc: evil@example.com', 'CFLab <x>']) {
      const { sent, binding } = fakeBinding();
      await sendTransactionalEmail(bindings({ AUTH_FROM_NAME: name, EMAIL: binding }), message);
      expect(sent[0]!.from).toBe('noreply@mail.aismallbizguru.com');
    }
  });

  it('maps a rejected send to a sanitized 503 and logs only the provider code', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => { logged.push(String(line)); });
    const rejected = Object.assign(new Error('recipient is suppressed'), { code: 'E_RECIPIENT_SUPPRESSED' });
    const { binding } = fakeBinding(() => { throw rejected; });
    const error = await sendTransactionalEmail(bindings({ EMAIL: binding }), message)
      .catch(e => e as { status: number; code: string; message: string });
    expect(error).toMatchObject({ status: 503, code: 'email_unavailable', message: 'Email delivery failed' });
    // The stable code is available to operators, but neither the recipient nor the
    // raw provider message appears in the log or in the API error.
    expect(logged.join('\n')).toContain('E_RECIPIENT_SUPPRESSED');
    expect(logged.join('\n')).not.toContain('user@example.com');
    expect(logged.join('\n')).not.toContain('recipient is suppressed');
    expect(JSON.stringify(error)).not.toContain('recipient is suppressed');
  });

  it('treats a thrown transport error without a code as a sanitized delivery failure', async () => {
    const { binding } = fakeBinding(() => { throw new Error('network down'); });
    await expect(sendTransactionalEmail(bindings({ EMAIL: binding }), message))
      .rejects.toMatchObject({ status: 503, code: 'email_unavailable', message: 'Email delivery failed' });
  });

  it('fails closed when the binding is absent or the sender is unusable', async () => {
    expect(emailProvider(bindings())).toBeNull();
    await expect(sendTransactionalEmail(bindings(), message))
      .rejects.toMatchObject({ status: 503, code: 'email_unavailable', message: 'Email delivery is not configured' });
    const { binding } = fakeBinding();
    for (const from of ['', '   ', 'not-an-email', 'evil\r\nBcc: x@example.com']) {
      await expect(sendTransactionalEmail(bindings({ AUTH_FROM_EMAIL: from, EMAIL: binding }), message))
        .rejects.toMatchObject({ status: 503, code: 'email_unavailable' });
    }
  });
});
