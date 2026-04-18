import { describe, test, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BotCredentialsForm } from '../BotCredentialsForm';

describe('BotCredentialsForm', () => {
  test('renders App ID and App Secret fields', () => {
    render(<BotCredentialsForm botId="bot_abc12345" onSave={async () => {}} />);
    expect(screen.getByLabelText(/App ID/)).toBeInTheDocument();
    expect(screen.getByLabelText(/App Secret/)).toBeInTheDocument();
  });

  test('App Secret field is of type password', () => {
    render(<BotCredentialsForm botId="bot_abc12345" onSave={async () => {}} />);
    const secretInput = screen.getByLabelText(/App Secret/);
    expect(secretInput).toHaveAttribute('type', 'password');
  });

  test('submit button is disabled when fields are empty', () => {
    render(<BotCredentialsForm botId="bot_abc12345" onSave={async () => {}} />);
    expect(screen.getByRole('button', { name: /保存凭证/ })).toBeDisabled();
  });

  test('submit button is disabled when only App ID is filled', async () => {
    render(<BotCredentialsForm botId="bot_abc12345" onSave={async () => {}} />);
    await userEvent.type(screen.getByLabelText(/App ID/), 'cli_xxx');
    expect(screen.getByRole('button', { name: /保存凭证/ })).toBeDisabled();
  });

  test('submit button is disabled when only App Secret is filled', async () => {
    render(<BotCredentialsForm botId="bot_abc12345" onSave={async () => {}} />);
    await userEvent.type(screen.getByLabelText(/App Secret/), 'sec_yyy');
    expect(screen.getByRole('button', { name: /保存凭证/ })).toBeDisabled();
  });

  test('submit button is enabled when both fields are filled', async () => {
    render(<BotCredentialsForm botId="bot_abc12345" onSave={async () => {}} />);
    await userEvent.type(screen.getByLabelText(/App ID/), 'cli_xxx');
    await userEvent.type(screen.getByLabelText(/App Secret/), 'sec_yyy');
    expect(screen.getByRole('button', { name: /保存凭证/ })).toBeEnabled();
  });

  test('calls onSave with appId and appSecret on submit', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<BotCredentialsForm botId="bot_abc12345" onSave={onSave} />);
    await userEvent.type(screen.getByLabelText(/App ID/), 'cli_xxx');
    await userEvent.type(screen.getByLabelText(/App Secret/), 'sec_yyy');
    await userEvent.click(screen.getByRole('button', { name: /保存凭证/ }));
    expect(onSave).toHaveBeenCalledWith('cli_xxx', 'sec_yyy');
  });

  test('clears fields after successful save', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<BotCredentialsForm botId="bot_abc12345" onSave={onSave} />);
    await userEvent.type(screen.getByLabelText(/App ID/), 'cli_xxx');
    await userEvent.type(screen.getByLabelText(/App Secret/), 'sec_yyy');
    await userEvent.click(screen.getByRole('button', { name: /保存凭证/ }));
    await waitFor(() => {
      expect(screen.getByLabelText(/App ID/)).toHaveValue('');
      expect(screen.getByLabelText(/App Secret/)).toHaveValue('');
    });
  });

  test('shows saving state during submission', async () => {
    let resolveSave!: () => void;
    const onSave = vi.fn().mockReturnValue(
      new Promise<void>((r) => {
        resolveSave = r;
      }),
    );
    render(<BotCredentialsForm botId="bot_abc12345" onSave={onSave} />);
    await userEvent.type(screen.getByLabelText(/App ID/), 'cli_xxx');
    await userEvent.type(screen.getByLabelText(/App Secret/), 'sec_yyy');
    await userEvent.click(screen.getByRole('button', { name: /保存凭证/ }));
    expect(screen.getByRole('button', { name: /保存中/ })).toBeInTheDocument();
    resolveSave();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /保存凭证/ }),
      ).toBeInTheDocument(),
    );
  });

  test('shows warning text about AES encryption', () => {
    render(<BotCredentialsForm botId="bot_abc12345" onSave={async () => {}} />);
    expect(screen.getByText(/AES-256-GCM/)).toBeInTheDocument();
  });

  test('shows re-invite warning hint', () => {
    render(<BotCredentialsForm botId="bot_abc12345" onSave={async () => {}} />);
    expect(screen.getByText(/拉入飞书群/)).toBeInTheDocument();
  });

  test('calls onSaved callback after successful save', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onSaved = vi.fn();
    render(
      <BotCredentialsForm
        botId="bot_abc12345"
        onSave={onSave}
        onSaved={onSaved}
      />,
    );
    await userEvent.type(screen.getByLabelText(/App ID/), 'cli_xxx');
    await userEvent.type(screen.getByLabelText(/App Secret/), 'sec_yyy');
    await userEvent.click(screen.getByRole('button', { name: /保存凭证/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});
