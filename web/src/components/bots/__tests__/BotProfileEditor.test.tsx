import { describe, test, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BotProfileEditor } from '../BotProfileEditor';

describe('BotProfileEditor', () => {
  test('loads content on mount', async () => {
    const load = vi
      .fn()
      .mockResolvedValue({ content: '# Role\n\nHello', mode: 'writer' });
    render(
      <BotProfileEditor botId="bot_a" onLoad={load} onSave={async () => {}} />,
    );
    await waitFor(() =>
      expect(screen.getByDisplayValue(/# Role/)).toBeInTheDocument(),
    );
  });

  test('save calls onSave with edited content', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <BotProfileEditor
        botId="bot_a"
        onLoad={async () => ({ content: '# Orig', mode: 'writer' })}
        onSave={onSave}
      />,
    );
    await waitFor(() => screen.getByDisplayValue('# Orig'));
    const textarea = screen.getByRole('textbox');
    await userEvent.clear(textarea);
    await userEvent.type(textarea, '# New');
    await userEvent.click(screen.getByRole('button', { name: /保存/ }));
    expect(onSave).toHaveBeenCalledWith('# New');
  });

  test('disabled save when content unchanged', async () => {
    render(
      <BotProfileEditor
        botId="bot_a"
        onLoad={async () => ({ content: 'X', mode: 'writer' })}
        onSave={async () => {}}
      />,
    );
    await waitFor(() => screen.getByDisplayValue('X'));
    expect(screen.getByRole('button', { name: /保存/ })).toBeDisabled();
  });

  test('shows advisor hint when mode=advisor', async () => {
    render(
      <BotProfileEditor
        botId="bot_a"
        onLoad={async () => ({ content: '', mode: 'advisor' })}
        onSave={async () => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(/只读模式/)).toBeInTheDocument(),
    );
  });

  test('shows character count', async () => {
    render(
      <BotProfileEditor
        botId="bot_a"
        onLoad={async () => ({ content: 'Hello', mode: 'writer' })}
        onSave={async () => {}}
      />,
    );
    await waitFor(() => screen.getByDisplayValue('Hello'));
    expect(screen.getByText(/5.*65536|65536/)).toBeInTheDocument();
  });

  test('shows loading state initially', () => {
    render(
      <BotProfileEditor
        botId="bot_a"
        onLoad={() => new Promise(() => {})}
        onSave={async () => {}}
      />,
    );
    // 加载中时保存按钮应该 disabled
    expect(screen.getByRole('button', { name: /保存/ })).toBeDisabled();
  });

  test('shows error state on load failure', async () => {
    render(
      <BotProfileEditor
        botId="bot_a"
        onLoad={async () => {
          throw new Error('Network error');
        }}
        onSave={async () => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(/加载失败/)).toBeInTheDocument(),
    );
  });

  test('onLoad is called with botId', async () => {
    const load = vi.fn().mockResolvedValue({ content: '', mode: 'writer' });
    render(
      <BotProfileEditor
        botId="bot_xyz"
        onLoad={load}
        onSave={async () => {}}
      />,
    );
    await waitFor(() => expect(load).toHaveBeenCalledWith('bot_xyz'));
  });
});
