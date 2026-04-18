import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import type { BotConcurrencyMode } from '../../stores/bots';

const MAX_CHARS = 65536; // 64KB 上限，对齐后端 schema

interface BotProfileData {
  content: string;
  mode: BotConcurrencyMode;
}

interface BotProfileEditorProps {
  botId: string;
  onLoad: (id: string) => Promise<BotProfileData>;
  onSave: (content: string) => Promise<void>;
  onClose?: () => void;
}

export function BotProfileEditor({
  botId,
  onLoad,
  onSave,
  onClose,
}: BotProfileEditorProps) {
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [mode, setMode] = useState<BotConcurrencyMode>('writer');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    onLoad(botId)
      .then((r) => {
        setContent(r.content);
        setOriginal(r.content);
        setMode(r.mode);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : '加载失败');
        setLoading(false);
      });
  }, [botId, onLoad]);

  const dirty = content !== original;
  const charCount = content.length;
  const overLimit = charCount > MAX_CHARS;

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(content);
      setOriginal(content);
      if (onClose) onClose();
    } finally {
      setSaving(false);
    }
  };

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3 text-destructive">
        <p className="text-sm">加载失败：{error}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setError(null);
            setLoading(true);
            onLoad(botId)
              .then((r) => {
                setContent(r.content);
                setOriginal(r.content);
                setMode(r.mode);
                setLoading(false);
              })
              .catch((err: unknown) => {
                setError(err instanceof Error ? err.message : '加载失败');
                setLoading(false);
              });
          }}
        >
          重试
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 h-full">
      {mode === 'advisor' && (
        <div className="text-xs px-3 py-2 rounded bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-400">
          此 Bot 为 <strong>只读模式</strong>
          （advisor）。建议在角色描述中说明分析边界与 scratch 输出约定。
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 flex-1 min-h-0">
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="min-h-[60vh] font-mono text-sm resize-none"
          placeholder={
            loading
              ? '加载中...'
              : '# 角色定义\n\n在此描述 Bot 的角色、能力和行为约定...'
          }
          disabled={loading}
          aria-label="Bot profile 编辑器"
        />
        <div className="min-h-[60vh] p-4 rounded border border-border bg-card overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              加载中...
            </div>
          ) : (
            <MarkdownRenderer content={content || '_（空）_'} variant="docs" />
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <span
          className={`text-xs tabular-nums ${overLimit ? 'text-destructive' : 'text-muted-foreground'}`}
          aria-live="polite"
        >
          {charCount} / {MAX_CHARS}
        </span>
        <div className="flex gap-2">
          {onClose && (
            <Button variant="outline" onClick={onClose} disabled={saving}>
              取消
            </Button>
          )}
          <Button
            onClick={handleSave}
            disabled={!dirty || saving || loading || overLimit}
          >
            {saving ? '保存中...' : '保存'}
          </Button>
        </div>
      </div>
    </div>
  );
}
