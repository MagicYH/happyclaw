// web/src/components/chat/__tests__/WorkspaceBotsPanel.test.tsx
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspaceBotsPanel } from '../WorkspaceBotsPanel';

const mockBots = [
  {
    id: 'bot_a',
    name: 'Alpha',
    channel: 'feishu',
    user_id: 'u1',
    connection_state: 'connected',
    concurrency_mode: 'writer',
    activation_mode: 'when_mentioned',
    status: 'active',
    default_folder: null,
    deleted_at: null,
    open_id: null,
    remote_name: null,
    created_at: '',
    updated_at: '',
    last_connected_at: null,
    consecutive_failures: 0,
    last_error_code: null,
  },
  {
    id: 'bot_b',
    name: 'Beta',
    channel: 'feishu',
    user_id: 'u1',
    connection_state: 'error',
    concurrency_mode: 'advisor',
    activation_mode: 'always',
    status: 'active',
    default_folder: null,
    deleted_at: null,
    open_id: null,
    remote_name: null,
    created_at: '',
    updated_at: '',
    last_connected_at: null,
    consecutive_failures: 3,
    last_error_code: 'AUTH_FAILED',
  },
] as any[];

const mockLoadBots = vi.fn();
const mockAddBinding = vi.fn();
const mockRemoveBinding = vi.fn();

vi.mock('../../../stores/bots', () => ({
  useBotsStore: () => ({
    bots: mockBots,
    loading: false,
    loadBots: mockLoadBots,
    addBinding: mockAddBinding,
    removeBinding: mockRemoveBinding,
  }),
}));

describe('WorkspaceBotsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('renders bound bots', async () => {
    render(
      <WorkspaceBotsPanel
        groupJid="web:main"
        fetchBindings={async () => ['bot_a', 'bot_b']}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('Beta')).toBeInTheDocument();
    });
  });

  test('empty state when no bindings', async () => {
    render(
      <WorkspaceBotsPanel groupJid="web:main" fetchBindings={async () => []} />,
    );
    await waitFor(() =>
      expect(screen.getByText(/暂无绑定/)).toBeInTheDocument(),
    );
  });

  test('shows concurrency mode badges', async () => {
    render(
      <WorkspaceBotsPanel
        groupJid="web:main"
        fetchBindings={async () => ['bot_a', 'bot_b']}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/writer/)).toBeInTheDocument();
      expect(screen.getByText(/advisor/)).toBeInTheDocument();
    });
  });

  test('calls loadBots on mount', async () => {
    render(
      <WorkspaceBotsPanel groupJid="web:main" fetchBindings={async () => []} />,
    );
    await waitFor(() => expect(mockLoadBots).toHaveBeenCalledTimes(1));
  });

  test('calls removeBinding when remove button clicked', async () => {
    render(
      <WorkspaceBotsPanel
        groupJid="web:main"
        fetchBindings={async () => ['bot_a']}
      />,
    );
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());

    const removeBtn = screen.getByTitle(/移除/);
    await userEvent.click(removeBtn);

    expect(mockRemoveBinding).toHaveBeenCalledWith('bot_a', 'web:main');
  });

  test('shows add bot button and lists unbound bots in selector', async () => {
    // bot_c is unbound (not in fetchBindings result)
    render(
      <WorkspaceBotsPanel
        groupJid="web:main"
        // only bot_a is bound; bot_b is available to add
        fetchBindings={async () => ['bot_a']}
      />,
    );
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());

    const addBtn = screen.getByTitle(/添加 Bot/);
    await userEvent.click(addBtn);

    // Beta should appear in the selector (not bound)
    await waitFor(() => expect(screen.getByText('Beta')).toBeInTheDocument());
  });

  test('calls addBinding when an unbound bot is selected', async () => {
    render(
      <WorkspaceBotsPanel
        groupJid="web:main"
        fetchBindings={async () => ['bot_a']}
      />,
    );
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());

    // Open selector
    const addBtn = screen.getByTitle(/添加 Bot/);
    await userEvent.click(addBtn);

    // Click Beta in the dropdown
    await waitFor(() => screen.getByText('Beta'));
    const betaOption = screen.getByRole('option', { name: /Beta/ });
    await userEvent.click(betaOption);

    expect(mockAddBinding).toHaveBeenCalledWith('bot_b', 'web:main');
  });

  test('shows WS bot_queue_status running/waiting info', async () => {
    render(
      <WorkspaceBotsPanel
        groupJid="web:main"
        fetchBindings={async () => ['bot_a']}
        queueStatus={{ running: ['bot_a'], waiting: [] }}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/运行中/)).toBeInTheDocument();
    });
  });

  test('shows waiting status from queue', async () => {
    render(
      <WorkspaceBotsPanel
        groupJid="web:main"
        fetchBindings={async () => ['bot_a']}
        queueStatus={{ running: [], waiting: ['bot_a'] }}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/等待中/)).toBeInTheDocument();
    });
  });
});
