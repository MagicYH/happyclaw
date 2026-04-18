import { describe, test, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BotDeleteConfirm } from '../BotDeleteConfirm';

const makeBot = (overrides: any = {}) => ({
  id: 'bot_abc12345',
  user_id: 'u1',
  channel: 'feishu',
  name: 'Frontend',
  activation_mode: 'when_mentioned',
  concurrency_mode: 'writer',
  status: 'active',
  connection_state: 'connected',
  consecutive_failures: 0,
  last_error_code: null,
  default_folder: null,
  deleted_at: null,
  open_id: null,
  remote_name: null,
  created_at: '',
  updated_at: '',
  last_connected_at: null,
  ...overrides,
});

describe('BotDeleteConfirm', () => {
  test('renders dialog with bot name when open', () => {
    render(
      <BotDeleteConfirm
        bot={makeBot({ name: 'MyBot' })}
        open={true}
        onOpenChange={() => {}}
        onConfirmed={() => {}}
      />,
    );
    expect(screen.getByText(/MyBot/)).toBeInTheDocument();
  });

  test('shows 30-day recovery message', () => {
    render(
      <BotDeleteConfirm
        bot={makeBot()}
        open={true}
        onOpenChange={() => {}}
        onConfirmed={() => {}}
      />,
    );
    expect(screen.getByText(/30 天/)).toBeInTheDocument();
  });

  test('shows soft-delete explanation', () => {
    render(
      <BotDeleteConfirm
        bot={makeBot()}
        open={true}
        onOpenChange={() => {}}
        onConfirmed={() => {}}
      />,
    );
    expect(screen.getByText(/软删除|可恢复/)).toBeInTheDocument();
  });

  test('confirm button triggers onConfirmed callback', async () => {
    const onConfirmed = vi.fn().mockResolvedValue(undefined);
    render(
      <BotDeleteConfirm
        bot={makeBot()}
        open={true}
        onOpenChange={() => {}}
        onConfirmed={onConfirmed}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /确认删除/ }));
    await waitFor(() => expect(onConfirmed).toHaveBeenCalled());
  });

  test('cancel button calls onOpenChange(false)', async () => {
    const onOpenChange = vi.fn();
    render(
      <BotDeleteConfirm
        bot={makeBot()}
        open={true}
        onOpenChange={onOpenChange}
        onConfirmed={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /取消/ }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('does not render dialog content when open=false', () => {
    render(
      <BotDeleteConfirm
        bot={makeBot({ name: 'HiddenBot' })}
        open={false}
        onOpenChange={() => {}}
        onConfirmed={() => {}}
      />,
    );
    expect(screen.queryByText(/HiddenBot/)).not.toBeInTheDocument();
  });

  test('confirm button shows loading state during deletion', async () => {
    let resolveDelete!: () => void;
    const onConfirmed = vi.fn().mockReturnValue(
      new Promise<void>((r) => {
        resolveDelete = r;
      }),
    );
    render(
      <BotDeleteConfirm
        bot={makeBot()}
        open={true}
        onOpenChange={() => {}}
        onConfirmed={onConfirmed}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /确认删除/ }));
    expect(screen.getByRole('button', { name: /删除中/ })).toBeInTheDocument();
    resolveDelete();
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: /删除中/ }),
      ).not.toBeInTheDocument(),
    );
  });

  test('includes bot name in dialog title', () => {
    render(
      <BotDeleteConfirm
        bot={makeBot({ name: 'SpecialBot' })}
        open={true}
        onOpenChange={() => {}}
        onConfirmed={() => {}}
      />,
    );
    expect(
      screen.getByRole('heading', { name: /SpecialBot/ }),
    ).toBeInTheDocument();
  });
});
