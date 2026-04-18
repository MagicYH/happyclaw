import { describe, test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BotCreateDialog } from '../BotCreateDialog';

describe('BotCreateDialog', () => {
  test('submits with filled name and default writer mode', async () => {
    const onCreate = vi.fn().mockResolvedValue({});
    render(<BotCreateDialog open={true} onClose={() => {}} onCreate={onCreate} />);
    await userEvent.type(screen.getByLabelText(/名称/), 'Alpha');
    await userEvent.click(screen.getByRole('button', { name: /创建/ }));
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Alpha', concurrency_mode: 'writer', channel: 'feishu' }),
    );
  });

  test('switch to advisor mode', async () => {
    const onCreate = vi.fn().mockResolvedValue({});
    render(<BotCreateDialog open={true} onClose={() => {}} onCreate={onCreate} />);
    await userEvent.type(screen.getByLabelText(/名称/), 'Reviewer');
    await userEvent.click(screen.getByLabelText(/advisor/));
    await userEvent.click(screen.getByRole('button', { name: /创建/ }));
    expect(onCreate.mock.calls[0][0].concurrency_mode).toBe('advisor');
  });

  test('empty name disables submit', async () => {
    render(<BotCreateDialog open={true} onClose={() => {}} onCreate={async () => ({} as any)} />);
    expect(screen.getByRole('button', { name: /创建/ })).toBeDisabled();
  });

  test('name > 50 chars shows validation error', async () => {
    render(<BotCreateDialog open={true} onClose={() => {}} onCreate={async () => ({} as any)} />);
    await userEvent.type(screen.getByLabelText(/名称/), 'a'.repeat(51));
    expect(screen.getByText(/最长 50/)).toBeInTheDocument();
  });

  test('pressing Escape calls onClose', async () => {
    const onClose = vi.fn();
    render(<BotCreateDialog open={true} onClose={onClose} onCreate={async () => ({} as any)} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  test('cancel button calls onClose', async () => {
    const onClose = vi.fn();
    render(<BotCreateDialog open={true} onClose={onClose} onCreate={async () => ({} as any)} />);
    await userEvent.click(screen.getByRole('button', { name: /取消/ }));
    expect(onClose).toHaveBeenCalled();
  });

  test('API error message is displayed', async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error('App ID 已存在'));
    render(<BotCreateDialog open={true} onClose={() => {}} onCreate={onCreate} />);
    await userEvent.type(screen.getByLabelText(/名称/), 'TestBot');
    await userEvent.click(screen.getByRole('button', { name: /创建/ }));
    expect(await screen.findByText(/App ID 已存在/)).toBeInTheDocument();
  });

  test('includes activation_mode in onCreate payload', async () => {
    const onCreate = vi.fn().mockResolvedValue({});
    render(<BotCreateDialog open={true} onClose={() => {}} onCreate={onCreate} />);
    await userEvent.type(screen.getByLabelText(/名称/), 'BotX');
    await userEvent.click(screen.getByRole('button', { name: /创建/ }));
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ activation_mode: expect.any(String) }),
    );
  });
});
