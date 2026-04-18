import { useState, useCallback, useEffect } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { BotProfileEditor } from './BotProfileEditor';
import { BotConnectionBadge } from './BotConnectionBadge';
import { useBotsStore, type Bot, type BotBinding } from '../../stores/bots';

interface Props {
  bot: Bot;
  onDelete: () => void;
}

export function BotEditor({ bot, onDelete }: Props) {
  const [name, setName] = useState(bot.name);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const store = useBotsStore();

  // Keep local name in sync if bot prop changes (e.g. after reload)
  useEffect(() => {
    setName(bot.name);
  }, [bot.name]);

  const handleSaveBasic = async () => {
    setSaving(true);
    try {
      await store.updateBot(bot.id, { name });
      toast.success('已保存');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleStatus = async () => {
    if (bot.status === 'active') {
      await store.disableBot(bot.id);
    } else {
      await store.enableBot(bot.id);
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    try {
      const r = await store.testConnection(bot.id);
      if (r.ok) {
        toast.success('连接成功');
      } else {
        toast.error(`连接失败：${r.error ?? '未知错误'}`);
      }
    } finally {
      setTesting(false);
    }
  };

  const loadProfile = useCallback((id: string) => store.getProfile(id), [store]);
  const saveProfile = useCallback(
    async (content: string) => {
      await store.saveProfile(bot.id, content);
      toast.success('角色已保存');
    },
    [store, bot.id],
  );

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold truncate">{bot.name}</h2>
          <BotConnectionBadge bot={bot} />
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" onClick={handleTestConnection} disabled={testing}>
            {testing ? '测试中...' : '测试连接'}
          </Button>
          <Button variant="outline" onClick={handleToggleStatus}>
            {bot.status === 'active' ? '停用' : '启用'}
          </Button>
          <Button variant="destructive" onClick={onDelete}>
            删除
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="basic">
        <TabsList>
          <TabsTrigger value="basic">基本信息</TabsTrigger>
          <TabsTrigger value="credentials">凭证</TabsTrigger>
          <TabsTrigger value="profile">角色</TabsTrigger>
          <TabsTrigger value="bindings">绑定</TabsTrigger>
        </TabsList>

        {/* Basic tab */}
        <TabsContent value="basic" className="space-y-3 pt-3">
          <div>
            <Label htmlFor="bot-editor-name">名称</Label>
            <Input
              id="bot-editor-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={50}
              className="mt-1"
            />
          </div>
          <div className="text-sm text-muted-foreground space-y-1">
            <p>并发模式：{bot.concurrency_mode}（创建后不可改）</p>
            <p>激活模式：{bot.activation_mode}</p>
            <p>渠道：{bot.channel}</p>
            <p>Open ID：{bot.open_id ?? '(未连接)'}</p>
            {bot.default_folder && <p>默认工作区：{bot.default_folder}</p>}
          </div>
          <Button
            onClick={handleSaveBasic}
            disabled={saving || name === bot.name || name.trim().length === 0}
          >
            {saving ? '保存中...' : '保存'}
          </Button>
        </TabsContent>

        {/* Credentials tab — BotCredentialsForm implemented in Task 10 */}
        <TabsContent value="credentials" className="pt-3">
          <div data-testid="credentials-placeholder" className="text-sm text-muted-foreground py-4">
            Credentials Form (Task 10)
          </div>
        </TabsContent>

        {/* Profile tab */}
        <TabsContent value="profile" className="pt-3">
          <BotProfileEditor botId={bot.id} onLoad={loadProfile} onSave={saveProfile} />
        </TabsContent>

        {/* Bindings tab */}
        <TabsContent value="bindings" className="pt-3">
          <BindingsList botId={bot.id} store={store} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// Bindings sub-component
interface BindingsListProps {
  botId: string;
  store: {
    listBindings: (id: string) => Promise<BotBinding[]>;
    addBinding: (id: string, groupJid: string) => Promise<void>;
    removeBinding: (id: string, groupJid: string) => Promise<void>;
  };
}

function BindingsList({ botId, store }: BindingsListProps) {
  const [bindings, setBindings] = useState<BotBinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [newJid, setNewJid] = useState('');
  const [adding, setAdding] = useState(false);
  const [removingJid, setRemovingJid] = useState<string | null>(null);

  const loadBindings = useCallback(async () => {
    setLoading(true);
    try {
      const result = await store.listBindings(botId);
      setBindings(result);
    } finally {
      setLoading(false);
    }
  }, [botId, store]);

  useEffect(() => {
    void loadBindings();
  }, [loadBindings]);

  const handleAdd = async () => {
    const jid = newJid.trim();
    if (!jid) return;
    setAdding(true);
    try {
      await store.addBinding(botId, jid);
      setNewJid('');
      await loadBindings();
      toast.success('绑定已添加');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '添加失败');
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (groupJid: string) => {
    setRemovingJid(groupJid);
    try {
      await store.removeBinding(botId, groupJid);
      await loadBindings();
      toast.success('绑定已移除');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '移除失败');
    } finally {
      setRemovingJid(null);
    }
  };

  if (loading) {
    return <div className="text-sm text-muted-foreground py-4">加载中...</div>;
  }

  return (
    <div className="space-y-4">
      {/* Existing bindings */}
      {bindings.length === 0 ? (
        <p className="text-sm text-muted-foreground">暂无绑定群组</p>
      ) : (
        <ul className="space-y-2">
          {bindings.map((b) => (
            <li
              key={b.group_jid}
              className="flex items-center justify-between gap-2 text-sm bg-muted/40 rounded px-3 py-2"
            >
              <span className="font-mono truncate">{b.group_jid}</span>
              <span className="text-xs text-muted-foreground shrink-0">{b.folder}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleRemove(b.group_jid)}
                disabled={removingJid === b.group_jid}
                aria-label={`移除 ${b.group_jid}`}
              >
                移除
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* Add new binding */}
      <div className="flex gap-2 items-end pt-2 border-t border-border">
        <div className="flex-1">
          <Label htmlFor="new-binding-jid" className="text-xs mb-1 block">
            添加群组 JID
          </Label>
          <Input
            id="new-binding-jid"
            value={newJid}
            onChange={(e) => setNewJid(e.target.value)}
            placeholder="feishu:oc_xxxx"
            className="h-8 text-sm"
          />
        </div>
        <Button
          size="sm"
          onClick={handleAdd}
          disabled={adding || !newJid.trim()}
        >
          {adding ? '添加中...' : '添加'}
        </Button>
      </div>
    </div>
  );
}
