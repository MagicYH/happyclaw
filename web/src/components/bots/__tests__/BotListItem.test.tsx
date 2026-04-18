// web/src/components/bots/__tests__/BotListItem.test.tsx
import { describe, test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BotListItem } from '../BotListItem';

const makeBot = (overrides: any = {}) => ({
  id: 'bot_abc12345', user_id: 'u1', channel: 'feishu', name: 'Frontend',
  activation_mode: 'when_mentioned', concurrency_mode: 'writer',
  status: 'active', connection_state: 'connected',
  consecutive_failures: 0, last_error_code: null,
  default_folder: null, deleted_at: null, open_id: null,
  remote_name: null, created_at: '', updated_at: '',
  last_connected_at: null,
  ...overrides,
});

describe('BotListItem', () => {
  test('shows name, channel badge, connection badge', () => {
    render(
      <BotListItem
        bot={makeBot()}
        selected={false}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText('Frontend')).toBeInTheDocument();
    expect(screen.getByText(/writer/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/已连接/)).toBeInTheDocument();
  });

  test('shows "advisor" badge when concurrency_mode=advisor', () => {
    render(
      <BotListItem bot={makeBot({ concurrency_mode: 'advisor' })} selected={false} onSelect={() => {}} />,
    );
    expect(screen.getByText(/advisor/i)).toBeInTheDocument();
  });

  test('onSelect fires on click', async () => {
    const onSelect = vi.fn();
    render(<BotListItem bot={makeBot()} selected={false} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole('button'));
    expect(onSelect).toHaveBeenCalledWith('bot_abc12345');
  });

  test('selected=true adds visual highlight class', () => {
    const { container } = render(
      <BotListItem bot={makeBot()} selected={true} onSelect={() => {}} />,
    );
    expect(container.querySelector('[aria-selected="true"]')).toBeInTheDocument();
  });

  test('error state shows retry hint', () => {
    render(
      <BotListItem
        bot={makeBot({ connection_state: 'error', consecutive_failures: 3, last_error_code: 'AUTH_FAILED' })}
        selected={false}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText(/连接失败/)).toBeInTheDocument();
  });
});
