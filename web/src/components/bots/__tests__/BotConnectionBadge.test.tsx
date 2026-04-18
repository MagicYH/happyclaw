import { describe, test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BotConnectionBadge } from '../BotConnectionBadge';
import type { Bot } from '../../../stores/bots';

const make = (overrides: Partial<Bot> = {}): Bot => ({
  id: 'bot_test',
  user_id: 'user_1',
  channel: 'feishu',
  name: 'Test Bot',
  default_folder: null,
  activation_mode: 'when_mentioned',
  concurrency_mode: 'writer',
  status: 'active',
  deleted_at: null,
  open_id: null,
  remote_name: null,
  created_at: '2026-04-17T00:00:00Z',
  updated_at: '2026-04-17T00:00:00Z',
  connection_state: 'connected',
  last_connected_at: '2026-04-17T10:00:00Z',
  consecutive_failures: 0,
  last_error_code: null,
  ...overrides,
});

describe('BotConnectionBadge', () => {
  test('connected → green dot + 已连接', () => {
    render(<BotConnectionBadge bot={make()} />);
    const el = screen.getByLabelText(/已连接/);
    expect(el).toBeInTheDocument();
    expect(el.className).toMatch(/text-emerald|text-green/);
  });

  test('error → red color + error code visible', () => {
    render(
      <BotConnectionBadge
        bot={make({
          connection_state: 'error',
          consecutive_failures: 2,
          last_error_code: 'AUTH_FAILED',
        })}
      />,
    );
    expect(screen.getByText(/AUTH_FAILED/)).toBeInTheDocument();
  });

  test('connecting → spinner + 连接中', () => {
    render(<BotConnectionBadge bot={make({ connection_state: 'connecting' })} />);
    expect(screen.getByLabelText(/连接中/)).toBeInTheDocument();
  });

  test('reconnecting → spinner + 重连中', () => {
    render(<BotConnectionBadge bot={make({ connection_state: 'reconnecting' })} />);
    expect(screen.getByLabelText(/重连中/)).toBeInTheDocument();
  });

  test('disconnected → muted color + 未连接', () => {
    render(<BotConnectionBadge bot={make({ connection_state: 'disconnected' })} />);
    const el = screen.getByLabelText(/未连接/);
    expect(el).toBeInTheDocument();
    expect(el.className).toMatch(/text-muted/);
  });

  test('disabled → muted color + 已停用', () => {
    render(<BotConnectionBadge bot={make({ connection_state: 'disabled', status: 'inactive' })} />);
    const el = screen.getByLabelText(/已停用/);
    expect(el).toBeInTheDocument();
    expect(el.className).toMatch(/text-muted/);
  });

  test('error without error code → only label shown', () => {
    render(
      <BotConnectionBadge
        bot={make({ connection_state: 'error', consecutive_failures: 1, last_error_code: null })}
      />,
    );
    const el = screen.getByLabelText(/连接失败/);
    expect(el).toBeInTheDocument();
    // Should not show parentheses when no error code
    expect(screen.queryByText(/（/)).not.toBeInTheDocument();
  });

  test('connected shows last_connected_at in title tooltip', () => {
    render(<BotConnectionBadge bot={make({ last_connected_at: '2026-04-17T10:00:00Z' })} />);
    const el = screen.getByLabelText(/已连接/);
    expect(el.getAttribute('title')).toContain('2026-04-17');
  });
});
