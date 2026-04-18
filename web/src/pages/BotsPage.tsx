import { useEffect, useState } from 'react';
import { Plus, Bot as BotIcon, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useBotsStore } from '../stores/bots';
import { useAuthStore } from '../stores/auth';
import { BotListItem } from '../components/bots/BotListItem';
import { BotCreateDialog } from '../components/bots/BotCreateDialog';
import { BotEditor } from '../components/bots/BotEditor';
import { BotDeleteConfirm } from '../components/bots/BotDeleteConfirm';
import type { Bot, BotCreateInput } from '../stores/bots';

export function BotsPage() {
  const enableMultiBot = useAuthStore((s) => s.enableMultiBot);

  const { bots, loading, error, loadBots, createBot, deleteBot } =
    useBotsStore();

  const [createOpen, setCreateOpen] = useState(false);
  const [selectedBot, setSelectedBot] = useState<Bot | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Bot | null>(null);

  useEffect(() => {
    void loadBots();
  }, [loadBots]);

  // Keep selectedBot in sync when bots list updates (e.g., after rename)
  useEffect(() => {
    if (selectedBot) {
      const updated = bots.find((b) => b.id === selectedBot.id) ?? null;
      setSelectedBot(updated);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bots]);

  if (!enableMultiBot) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
        <BotIcon size={48} className="text-muted-foreground/40" />
        <p className="text-muted-foreground">Multi-Bot 功能未启用</p>
      </div>
    );
  }

  const handleCreate = async (input: BotCreateInput) => {
    const bot = await createBot(input);
    setSelectedBot(bot);
  };

  const handleDeleteRequest = () => {
    if (selectedBot) setDeleteTarget(selectedBot);
  };

  const handleDeleteConfirmed = async () => {
    if (!deleteTarget) return;
    await deleteBot(deleteTarget.id);
    if (selectedBot?.id === deleteTarget.id) setSelectedBot(null);
    setDeleteTarget(null);
  };

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left panel: list */}
      <aside className="w-72 shrink-0 border-r border-border flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <h1 className="font-semibold text-base">Bot 管理</h1>
          <Button
            size="sm"
            onClick={() => setCreateOpen(true)}
            aria-label="创建 Bot"
          >
            <Plus size={16} className="mr-1" />
            创建
          </Button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {error && (
            <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {loading && bots.length === 0 && (
            <div className="space-y-2 px-1 pt-1">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-16 rounded-lg bg-muted/50 animate-pulse"
                  aria-label="加载中"
                />
              ))}
            </div>
          )}

          {!loading && !error && bots.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center px-4">
              <BotIcon size={36} className="text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">
                还没有 Bot，点击右上角「创建」开始添加
              </p>
            </div>
          )}

          {bots.map((bot) => (
            <BotListItem
              key={bot.id}
              bot={bot}
              selected={selectedBot?.id === bot.id}
              onSelect={(id) => {
                const found = bots.find((b) => b.id === id) ?? null;
                setSelectedBot(found);
              }}
            />
          ))}
        </div>
      </aside>

      {/* Right panel: editor */}
      <main className="flex-1 overflow-y-auto p-6">
        {selectedBot ? (
          <BotEditor bot={selectedBot} onDelete={handleDeleteRequest} />
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-center">
            <BotIcon size={48} className="text-muted-foreground/20" />
            <p className="text-muted-foreground text-sm">
              {bots.length > 0
                ? '选择一个 Bot 进行配置'
                : '创建第一个 Bot 开始使用'}
            </p>
          </div>
        )}
      </main>

      {/* Create dialog */}
      <BotCreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={handleCreate}
      />

      {/* Delete confirm */}
      {deleteTarget && (
        <BotDeleteConfirm
          bot={deleteTarget}
          open={true}
          onOpenChange={(v) => {
            if (!v) setDeleteTarget(null);
          }}
          onConfirmed={handleDeleteConfirmed}
        />
      )}
    </div>
  );
}
