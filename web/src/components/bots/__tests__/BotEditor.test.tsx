import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BotEditor } from '../BotEditor';

// Mock useBotsStore
const mockStore = {
  updateBot: vi.fn().mockResolvedValue(undefined),
  updateCredentials: vi.fn().mockResolvedValue(undefined),
  enableBot: vi.fn().mockResolvedValue(undefined),
  disableBot: vi.fn().mockResolvedValue(undefined),
  testConnection: vi.fn().mockResolvedValue({ ok: true }),
  getProfile: vi
    .fn()
    .mockResolvedValue({ content: '# Profile', mode: 'writer' }),
  saveProfile: vi.fn().mockResolvedValue(undefined),
  listBindings: vi.fn().mockResolvedValue([]),
  addBinding: vi.fn().mockResolvedValue(undefined),
  removeBinding: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../../stores/bots', () => ({
  useBotsStore: () => mockStore,
}));

// Mock toast
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock BotProfileEditor to avoid complex rendering
vi.mock('../BotProfileEditor', () => ({
  BotProfileEditor: ({ botId }: { botId: string }) => (
    <div data-testid="bot-profile-editor">ProfileEditor for {botId}</div>
  ),
}));

const makeBot = (overrides: Record<string, unknown> = {}) => ({
  id: 'bot_test123',
  user_id: 'u1',
  channel: 'feishu' as const,
  name: 'TestBot',
  default_folder: null,
  activation_mode: 'when_mentioned' as const,
  concurrency_mode: 'writer' as const,
  status: 'active' as const,
  deleted_at: null,
  open_id: null,
  remote_name: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  connection_state: 'connected' as const,
  last_connected_at: null,
  consecutive_failures: 0,
  last_error_code: null,
  ...overrides,
});

describe('BotEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.listBindings.mockResolvedValue([]);
    mockStore.getProfile.mockResolvedValue({
      content: '# Profile',
      mode: 'writer',
    });
    mockStore.testConnection.mockResolvedValue({ ok: true });
    mockStore.updateBot.mockResolvedValue(undefined);
  });

  // --- Header ---
  test('displays bot name in header', () => {
    render(<BotEditor bot={makeBot()} onDelete={() => {}} />);
    expect(screen.getByText('TestBot')).toBeInTheDocument();
  });

  test('displays BotConnectionBadge in header', () => {
    render(
      <BotEditor
        bot={makeBot({ connection_state: 'connected' })}
        onDelete={() => {}}
      />,
    );
    expect(screen.getByLabelText(/已连接/)).toBeInTheDocument();
  });

  // --- Tabs present ---
  test('renders 4 tabs: 基本信息, 凭证, 角色, 绑定', () => {
    render(<BotEditor bot={makeBot()} onDelete={() => {}} />);
    expect(screen.getByRole('tab', { name: '基本信息' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '凭证' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '角色' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '绑定' })).toBeInTheDocument();
  });

  // --- Basic tab (default active) ---
  test('basic tab is active by default and shows name input', () => {
    render(<BotEditor bot={makeBot()} onDelete={() => {}} />);
    const input = screen.getByLabelText(/名称/);
    expect(input).toBeInTheDocument();
    expect((input as HTMLInputElement).value).toBe('TestBot');
  });

  test('save button disabled when name unchanged', () => {
    render(<BotEditor bot={makeBot()} onDelete={() => {}} />);
    expect(screen.getByRole('button', { name: /^保存$/ })).toBeDisabled();
  });

  test('save button enabled after name change', async () => {
    render(<BotEditor bot={makeBot()} onDelete={() => {}} />);
    const input = screen.getByLabelText(/名称/);
    await userEvent.clear(input);
    await userEvent.type(input, 'NewName');
    expect(screen.getByRole('button', { name: /^保存$/ })).not.toBeDisabled();
  });

  test('save button calls updateBot with new name', async () => {
    render(<BotEditor bot={makeBot()} onDelete={() => {}} />);
    const input = screen.getByLabelText(/名称/);
    await userEvent.clear(input);
    await userEvent.type(input, 'Renamed');
    await userEvent.click(screen.getByRole('button', { name: /^保存$/ }));
    await waitFor(() =>
      expect(mockStore.updateBot).toHaveBeenCalledWith(
        'bot_test123',
        expect.objectContaining({ name: 'Renamed' }),
      ),
    );
  });

  test('shows concurrency_mode as read-only info', () => {
    render(
      <BotEditor
        bot={makeBot({ concurrency_mode: 'advisor' })}
        onDelete={() => {}}
      />,
    );
    expect(screen.getByText(/advisor/)).toBeInTheDocument();
  });

  // --- Credentials tab ---
  test('switching to 凭证 tab shows credentials placeholder', async () => {
    render(<BotEditor bot={makeBot()} onDelete={() => {}} />);
    await userEvent.click(screen.getByRole('tab', { name: '凭证' }));
    expect(screen.getByTestId('credentials-placeholder')).toBeInTheDocument();
  });

  // --- Profile tab ---
  test('switching to 角色 tab shows BotProfileEditor', async () => {
    render(<BotEditor bot={makeBot()} onDelete={() => {}} />);
    await userEvent.click(screen.getByRole('tab', { name: '角色' }));
    expect(screen.getByTestId('bot-profile-editor')).toBeInTheDocument();
  });

  // --- Bindings tab ---
  test('switching to 绑定 tab triggers listBindings', async () => {
    render(<BotEditor bot={makeBot()} onDelete={() => {}} />);
    await userEvent.click(screen.getByRole('tab', { name: '绑定' }));
    await waitFor(() =>
      expect(mockStore.listBindings).toHaveBeenCalledWith('bot_test123'),
    );
  });

  test('bindings tab shows empty state when no bindings', async () => {
    mockStore.listBindings.mockResolvedValue([]);
    render(<BotEditor bot={makeBot()} onDelete={() => {}} />);
    await userEvent.click(screen.getByRole('tab', { name: '绑定' }));
    await waitFor(() =>
      expect(screen.getByText(/暂无绑定|没有绑定/)).toBeInTheDocument(),
    );
  });

  test('bindings tab shows existing binding group_jid', async () => {
    mockStore.listBindings.mockResolvedValue([
      { group_jid: 'feishu:room123', folder: 'main' },
    ]);
    render(<BotEditor bot={makeBot()} onDelete={() => {}} />);
    await userEvent.click(screen.getByRole('tab', { name: '绑定' }));
    await waitFor(() =>
      expect(screen.getByText(/feishu:room123/)).toBeInTheDocument(),
    );
  });

  test('remove binding button calls removeBinding', async () => {
    mockStore.listBindings.mockResolvedValue([
      { group_jid: 'feishu:room123', folder: 'main' },
    ]);
    render(<BotEditor bot={makeBot()} onDelete={() => {}} />);
    await userEvent.click(screen.getByRole('tab', { name: '绑定' }));
    await waitFor(() => screen.getByText(/feishu:room123/));
    const removeBtn = screen.getByRole('button', { name: /移除/ });
    await userEvent.click(removeBtn);
    await waitFor(() =>
      expect(mockStore.removeBinding).toHaveBeenCalledWith(
        'bot_test123',
        'feishu:room123',
      ),
    );
  });

  // --- Header action buttons ---
  test('test connection button calls testConnection', async () => {
    render(<BotEditor bot={makeBot()} onDelete={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: /测试连接/ }));
    await waitFor(() =>
      expect(mockStore.testConnection).toHaveBeenCalledWith('bot_test123'),
    );
  });

  test('disable button calls disableBot when bot is active', async () => {
    render(
      <BotEditor bot={makeBot({ status: 'active' })} onDelete={() => {}} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /停用/ }));
    await waitFor(() =>
      expect(mockStore.disableBot).toHaveBeenCalledWith('bot_test123'),
    );
  });

  test('enable button calls enableBot when bot is inactive', async () => {
    render(
      <BotEditor bot={makeBot({ status: 'inactive' })} onDelete={() => {}} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /启用/ }));
    await waitFor(() =>
      expect(mockStore.enableBot).toHaveBeenCalledWith('bot_test123'),
    );
  });

  test('delete button calls onDelete', async () => {
    const onDelete = vi.fn();
    render(<BotEditor bot={makeBot()} onDelete={onDelete} />);
    await userEvent.click(screen.getByRole('button', { name: /删除/ }));
    expect(onDelete).toHaveBeenCalled();
  });
});
