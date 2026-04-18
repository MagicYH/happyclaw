import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

interface Props {
  botId: string;
  onSave: (appId: string, appSecret: string) => Promise<void>;
  onSaved?: () => void;
}

export function BotCredentialsForm({ onSave, onSaved }: Props) {
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    setSaving(true);
    try {
      await onSave(appId, appSecret);
      toast.success('凭证已更新');
      setAppId('');
      setAppSecret('');
      onSaved?.();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground">
        凭证会使用 AES-256-GCM 加密存储。保存后不会回显，需要覆盖时请重新填入完整值。
      </div>
      <div>
        <Label htmlFor="credentials-appid">App ID</Label>
        <Input
          id="credentials-appid"
          value={appId}
          onChange={(e) => setAppId(e.target.value)}
          placeholder="cli_xxx"
        />
      </div>
      <div>
        <Label htmlFor="credentials-secret">App Secret</Label>
        <Input
          id="credentials-secret"
          type="password"
          value={appSecret}
          onChange={(e) => setAppSecret(e.target.value)}
        />
      </div>
      <Button
        disabled={saving || !appId || !appSecret}
        onClick={handleSubmit}
      >
        {saving ? '保存中...' : '保存凭证'}
      </Button>
      <p className="text-xs text-amber-600 dark:text-amber-400">
        注意：更新凭证后，需要重新把 Bot 拉入飞书群才能恢复消息接收。
      </p>
    </div>
  );
}
