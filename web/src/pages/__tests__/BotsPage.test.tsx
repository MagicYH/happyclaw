// web/src/pages/__tests__/BotsPage.test.tsx
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { BotsPage } from '../BotsPage';

// ──────────────────────────────────────────────
// Mock: useBotsStore
// ──────────────────────────────────────────────
const mockBot = {
  id: 'bot_test1',
  user_id: 'u1',
  channel: 'feishu' as const,
  name: 'MyTestBot',
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
};

const mockLoadBots = vi.fn().mockResolvedValue(undefined);
const mockCreateBot = vi.fn().mockResolvedValue({ ...mockBot, id: 'bot_new' });
const mockDeleteBot = vi.fn().mockResolvedValue(undefined);

// Mutable state object so individual tests can override
const mockBotsState = {
  bots: [mockBot],
  loading: false,
  error: null as string | null,
  saving: false,
  loadBots: mockLoadBots,
  createBot: mockCreateBot,
  deleteBot: mockDeleteBot,
  updateBot: vi.fn().mockResolvedValue(undefined),
  updateCredentials: vi.fn().mockResolvedValue(undefined),
  enableBot: vi.fn().mockResolvedValue(undefined),
  disableBot: vi.fn().mockResolvedValue(undefined),
  testConnection: vi.fn().mockResolvedValue({ ok: true }),
  getProfile: vi.fn().mockResolvedValue({ content: '', mode: 'writer' }),
  saveProfile: vi.fn().mockResolvedValue(undefined),
  readProfile: vi.fn().mockResolvedValue({ content: '', mode: 'writer' }),
  writeProfile: vi.fn().mockResolvedValue(undefined),
  getBindings: vi.fn().mockResolvedValue([]),
  listBindings: vi.fn().mockResolvedValue([]),
  addBinding: vi.fn().mockResolvedValue(undefined),
  removeBinding: vi.fn().mockResolvedValue(undefined),
  applyConnectionStatus: vi.fn(),
};

vi.mock('../../stores/bots', () => ({
  useBotsStore: () => mockBotsState,
}));

// ──────────────────────────────────────────────
// Mock: useAuthStore — enableMultiBot flag
// ──────────────────────────────────────────────
// Use a mutable object so tests can flip the flag via authOverrides
const authOverrides = { enableMultiBot: true };

vi.mock('../../stores/auth', () => ({
  useAuthStore: (selector: (s: any) => any) =>
    selector({
      user: { id: 'u1', role: 'admin', permissions: [] },
      ...authOverrides,
    }),
}));

// ──────────────────────────────────────────────
// Mock child components (keep tests focused on BotsPage logic)
// ──────────────────────────────────────────────
vi.mock('../../components/bots/BotListItem', () => ({
  BotListItem: ({
    bot,
    onSelect,
  }: {
    bot: { name: string; id: string };
    onSelect: (id: string) => void;
  }) => (
    <button data-testid={`bot-item-${bot.id}`} onClick={() => onSelect(bot.id)}>
      {bot.name}
    </button>
  ),
}));

vi.mock('../../components/bots/BotCreateDialog', () => ({
  BotCreateDialog: ({
    open,
    onClose,
    onCreate,
  }: {
    open: boolean;
    onClose: () => void;
    onCreate: (input: any) => Promise<unknown>;
  }) =>
    open ? (
      <div data-testid="bot-create-dialog">
        <button onClick={() => onCreate({ name: 'NewBot', channel: 'feishu' })}>
          确认创建
        </button>
        <button onClick={onClose}>取消</button>
      </div>
    ) : null,
}));

vi.mock('../../components/bots/BotEditor', () => ({
  BotEditor: ({
    bot,
    onDelete,
  }: {
    bot: { name: string };
    onDelete: () => void;
  }) => (
    <div data-testid="bot-editor">
      编辑: {bot.name}
      <button onClick={onDelete}>删除Bot</button>
    </div>
  ),
}));

vi.mock('../../components/bots/BotDeleteConfirm', () => ({
  BotDeleteConfirm: ({
    open,
    onOpenChange,
    onConfirmed,
  }: {
    open: boolean;
    bot: any;
    onOpenChange: (v: boolean) => void;
    onConfirmed?: () => Promise<void> | void;
  }) =>
    open ? (
      <div data-testid="bot-delete-confirm">
        <button
          onClick={() => {
            void onConfirmed?.();
          }}
        >
          确认删除
        </button>
        <button onClick={() => onOpenChange(false)}>取消</button>
      </div>
    ) : null,
}));

// ──────────────────────────────────────────────
// Helper
// ──────────────────────────────────────────────
function renderBotsPage() {
  return render(
    <MemoryRouter>
      <BotsPage />
    </MemoryRouter>,
  );
}

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────
describe('BotsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBotsState.bots = [mockBot];
    mockBotsState.loading = false;
    mockBotsState.error = null;
    authOverrides.enableMultiBot = true;
  });

  test('calls loadBots on mount', async () => {
    renderBotsPage();
    await waitFor(() => expect(mockLoadBots).toHaveBeenCalledTimes(1));
  });

  test('renders bot list items', async () => {
    renderBotsPage();
    expect(await screen.findByTestId('bot-item-bot_test1')).toBeInTheDocument();
    expect(screen.getByText('MyTestBot')).toBeInTheDocument();
  });

  test('shows empty state when no bots', () => {
    mockBotsState.bots = [];
    renderBotsPage();
    expect(screen.getByText(/还没有 Bot|尚未创建/i)).toBeInTheDocument();
  });

  test('shows loading skeleton when loading=true and no bots yet', () => {
    mockBotsState.loading = true;
    mockBotsState.bots = [];
    renderBotsPage();
    // While loading, bot items should not be in the DOM
    expect(screen.queryByTestId('bot-item-bot_test1')).not.toBeInTheDocument();
    // Loading placeholder (aria-label) should appear
    expect(document.querySelector('[aria-label="加载中"]')).toBeInTheDocument();
  });

  test('shows error message when error is set', () => {
    mockBotsState.error = '网络错误';
    mockBotsState.bots = [];
    renderBotsPage();
    expect(screen.getByText(/网络错误/)).toBeInTheDocument();
  });

  test('create button opens BotCreateDialog', async () => {
    renderBotsPage();
    const createBtn = screen.getByRole('button', { name: /创建/i });
    await userEvent.click(createBtn);
    expect(screen.getByTestId('bot-create-dialog')).toBeInTheDocument();
  });

  test('BotCreateDialog cancel button hides dialog', async () => {
    renderBotsPage();
    const createBtn = screen.getByRole('button', { name: /创建/i });
    await userEvent.click(createBtn);
    expect(screen.getByTestId('bot-create-dialog')).toBeInTheDocument();
    await userEvent.click(screen.getByText('取消'));
    expect(screen.queryByTestId('bot-create-dialog')).not.toBeInTheDocument();
  });

  test('clicking a bot item opens BotEditor', async () => {
    renderBotsPage();
    const botItem = await screen.findByTestId('bot-item-bot_test1');
    await userEvent.click(botItem);
    expect(screen.getByTestId('bot-editor')).toBeInTheDocument();
    expect(screen.getByText(/编辑: MyTestBot/)).toBeInTheDocument();
  });

  test('clicking delete in BotEditor opens BotDeleteConfirm', async () => {
    renderBotsPage();
    const botItem = await screen.findByTestId('bot-item-bot_test1');
    await userEvent.click(botItem);
    await userEvent.click(screen.getByText('删除Bot'));
    expect(screen.getByTestId('bot-delete-confirm')).toBeInTheDocument();
  });

  test('confirming delete calls store.deleteBot and clears editor', async () => {
    renderBotsPage();
    const botItem = await screen.findByTestId('bot-item-bot_test1');
    await userEvent.click(botItem);
    await userEvent.click(screen.getByText('删除Bot'));
    await userEvent.click(screen.getByText('确认删除'));
    await waitFor(() =>
      expect(mockDeleteBot).toHaveBeenCalledWith('bot_test1'),
    );
    await waitFor(() =>
      expect(screen.queryByTestId('bot-editor')).not.toBeInTheDocument(),
    );
  });

  test('enableMultiBot=false: shows feature-disabled message instead of bot list', () => {
    authOverrides.enableMultiBot = false;
    renderBotsPage();
    expect(screen.queryByTestId('bot-item-bot_test1')).not.toBeInTheDocument();
    expect(screen.getByText(/Multi-Bot 功能未启用/)).toBeInTheDocument();
  });
});
