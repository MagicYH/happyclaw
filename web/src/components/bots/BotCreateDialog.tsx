import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import type { BotCreateInput, BotConcurrencyMode, BotActivationMode } from '../../stores/bots';

interface BotCreateDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (input: BotCreateInput) => Promise<unknown>;
}

const NAME_MAX = 50;

export function BotCreateDialog({ open, onClose, onCreate }: BotCreateDialogProps) {
  const [name, setName] = useState('');
  const [concurrency, setConcurrency] = useState<BotConcurrencyMode>('writer');
  const [activation, setActivation] = useState<BotActivationMode>('when_mentioned');
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  const tooLong = name.length > NAME_MAX;
  const canSubmit = !saving && name.trim().length > 0 && !tooLong;

  const reset = () => {
    setName('');
    setConcurrency('writer');
    setActivation('when_mentioned');
    setAppId('');
    setAppSecret('');
    setApiError(null);
  };

  const handleClose = () => {
    if (!saving) {
      reset();
      onClose();
    }
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setApiError(null);
    try {
      await onCreate({
        name: name.trim(),
        channel: 'feishu',
        activation_mode: activation,
        concurrency_mode: concurrency,
        ...(appId && appSecret ? { app_id: appId, app_secret: appSecret } : {}),
      });
      reset();
      onClose();
    } catch (err) {
      setApiError(err instanceof Error ? err.message : '创建失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建 Bot</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* 名称 */}
          <div>
            <Label htmlFor="bot-name" className="mb-1">
              名称 <span className="text-destructive">*</span>
            </Label>
            <Input
              id="bot-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：Frontend-Dev"
              disabled={saving}
              aria-describedby={tooLong ? 'bot-name-error' : undefined}
            />
            {tooLong && (
              <p id="bot-name-error" className="mt-1 text-xs text-destructive">
                名称最长 50 字符，当前 {name.length} 字符
              </p>
            )}
          </div>

          {/* 并发模式 */}
          <div>
            <Label className="mb-2 block">并发模式</Label>
            <div className="flex gap-6">
              <label className="flex items-center gap-2 cursor-pointer text-sm">
                <input
                  type="radio"
                  name="concurrency"
                  aria-label="writer"
                  checked={concurrency === 'writer'}
                  onChange={() => setConcurrency('writer')}
                  disabled={saving}
                />
                <span>writer（可写项目）</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer text-sm">
                <input
                  type="radio"
                  name="concurrency"
                  aria-label="advisor"
                  checked={concurrency === 'advisor'}
                  onChange={() => setConcurrency('advisor')}
                  disabled={saving}
                />
                <span>advisor（只读）</span>
              </label>
            </div>
          </div>

          {/* 激活方式 */}
          <div>
            <Label className="mb-2 block">激活方式</Label>
            <div className="flex gap-6">
              <label className="flex items-center gap-2 cursor-pointer text-sm">
                <input
                  type="radio"
                  name="activation"
                  checked={activation === 'when_mentioned'}
                  onChange={() => setActivation('when_mentioned')}
                  disabled={saving}
                />
                <span>@提及时</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer text-sm">
                <input
                  type="radio"
                  name="activation"
                  checked={activation === 'always'}
                  onChange={() => setActivation('always')}
                  disabled={saving}
                />
                <span>总是响应</span>
              </label>
            </div>
          </div>

          {/* 可选：飞书凭证 */}
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground transition-colors">
              可选：立即填写飞书凭证（也可创建后再编辑）
            </summary>
            <div className="mt-3 space-y-3 pl-1">
              <div>
                <Label htmlFor="bot-appid" className="mb-1">
                  App ID
                </Label>
                <Input
                  id="bot-appid"
                  value={appId}
                  onChange={(e) => setAppId(e.target.value)}
                  placeholder="cli_xxxxxxxx"
                  disabled={saving}
                />
              </div>
              <div>
                <Label htmlFor="bot-secret" className="mb-1">
                  App Secret
                </Label>
                <Input
                  id="bot-secret"
                  type="password"
                  value={appSecret}
                  onChange={(e) => setAppSecret(e.target.value)}
                  placeholder="••••••••"
                  disabled={saving}
                />
              </div>
            </div>
          </details>

          {/* API 错误 */}
          {apiError && (
            <p className="text-sm text-destructive rounded-md bg-destructive/10 px-3 py-2">
              {apiError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={saving}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {saving && <Loader2 className="size-4 animate-spin mr-1" />}
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
