import { useEffect, useState, useCallback } from 'react';
import { Plus, Trash2, RefreshCw, Loader2, Bot } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/common/EmptyState';
import { useBotsStore } from '../../stores/bots';
import { BotConnectionBadge } from '../bots/BotConnectionBadge';
import type { Bot as BotType } from '../../stores/bots';

export interface BotQueueStatus {
  running: string[];  // bot_id[]
  waiting: string[];  // bot_id[]
}

interface WorkspaceBotsPanelProps {
  groupJid: string;
  fetchBindings: (jid: string) => Promise<string[]>;
  queueStatus?: BotQueueStatus;
}

export function WorkspaceBotsPanel({
  groupJid,
  fetchBindings,
  queueStatus,
}: WorkspaceBotsPanelProps) {
  const { bots, loading, loadBots, addBinding, removeBinding } = useBotsStore();
  const [boundIds, setBoundIds] = useState<string[]>([]);
  const [fetching, setFetching] = useState(false);
  const [showSelector, setShowSelector] = useState(false);

  useEffect(() => {
    loadBots();
  }, [loadBots]);

  const refreshBindings = useCallback(() => {
    let alive = true;
    setFetching(true);
    fetchBindings(groupJid)
      .then((ids) => {
        if (alive) setBoundIds(ids);
      })
      .finally(() => {
        if (alive) setFetching(false);
      });
    return () => {
      alive = false;
    };
  }, [groupJid, fetchBindings]);

  useEffect(() => {
    const cancel = refreshBindings();
    return cancel;
  }, [refreshBindings]);

  const handleRemove = async (botId: string) => {
    await removeBinding(botId, groupJid);
    setBoundIds((prev) => prev.filter((id) => id !== botId));
  };

  const handleAdd = async (botId: string) => {
    await addBinding(botId, groupJid);
    setBoundIds((prev) => [...prev, botId]);
    setShowSelector(false);
  };

  const boundBots = bots.filter((b) => boundIds.includes(b.id));
  const unboundBots = bots.filter((b) => !boundIds.includes(b.id) && b.status === 'active' && !b.deleted_at);

  const isLoading = loading || fetching;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border flex-shrink-0">
        <h3 className="text-sm font-medium text-foreground">工作区 Bots</h3>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={refreshBindings}
            disabled={isLoading}
            className="h-7 w-7 p-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowSelector((v) => !v)}
            className="h-7 w-7 p-0"
            title="添加 Bot"
          >
            <Plus className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Bot selector dropdown */}
      {showSelector && (
        <div className="px-4 py-2 border-b border-border flex-shrink-0">
          <p className="text-xs text-muted-foreground mb-1.5">选择要添加的 Bot</p>
          {unboundBots.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2 text-center">
              暂无可添加的 Bot（所有 Bot 已绑定或未激活）
            </p>
          ) : (
            <div className="space-y-1">
              {unboundBots.map((bot) => (
                <button
                  key={bot.id}
                  role="option"
                  aria-selected={false}
                  onClick={() => handleAdd(bot.id)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-accent text-left transition-colors cursor-pointer"
                >
                  <Bot className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                  <span className="text-sm flex-1 truncate">{bot.name}</span>
                  <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                    {bot.concurrency_mode}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Bot list */}
      <div className="flex-1 overflow-y-auto">
        {isLoading && boundBots.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : boundBots.length === 0 ? (
          <EmptyState
            icon={Bot}
            title="暂无绑定的 Bot"
            description="点击右上角 + 添加 Bot 到此工作区"
            action={
              <Button variant="outline" size="sm" onClick={() => setShowSelector(true)}>
                <Plus className="w-3.5 h-3.5 mr-1" />
                添加 Bot
              </Button>
            }
          />
        ) : (
          <div className="divide-y divide-border">
            {boundBots.map((bot) => (
              <BotRow
                key={bot.id}
                bot={bot}
                onRemove={() => handleRemove(bot.id)}
                queueStatus={queueStatus}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface BotRowProps {
  bot: BotType;
  onRemove: () => void;
  queueStatus?: BotQueueStatus;
}

function BotRow({ bot, onRemove, queueStatus }: BotRowProps) {
  const isRunning = queueStatus?.running.includes(bot.id);
  const isWaiting = queueStatus?.waiting.includes(bot.id);

  return (
    <div className="flex items-start gap-3 px-4 py-2.5 hover:bg-accent/50 transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-sm font-medium text-foreground truncate">{bot.name}</span>
          <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
            {bot.concurrency_mode}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 flex-wrap">
          <BotConnectionBadge bot={bot} />
          {isRunning && (
            <span className="text-xs text-emerald-600 font-medium">运行中</span>
          )}
          {isWaiting && (
            <span className="text-xs text-amber-500 font-medium">等待中</span>
          )}
        </div>
      </div>
      <button
        onClick={onRemove}
        title="移除 Bot"
        className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-destructive transition-colors flex-shrink-0 cursor-pointer"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
