import { useEffect, useState } from 'react';
import {
  ArrowRight,
  Bot,
  Loader2,
  MessageSquare,
  QrCode,
  SkipForward,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { useAuthStore } from '../stores/auth';
import { api } from '../api/client';
import { getErrorMessage } from '../components/settings/types';
import { WeChatQRDialog } from '../components/settings/WeChatQRDialog';
import { showToast } from '../utils/toast';

export function SetupChannelsPage() {
  const navigate = useNavigate();
  const { user, initialized, enableMultiBot } = useAuthStore();

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [migrating, setMigrating] = useState(false);

  // Feishu existing config detection
  const [hasLegacyFeishu, setHasLegacyFeishu] = useState(false);

  // Feishu
  const [feishuAppId, setFeishuAppId] = useState('');
  const [feishuAppSecret, setFeishuAppSecret] = useState('');

  // Telegram
  const [telegramBotToken, setTelegramBotToken] = useState('');

  // QQ
  const [qqAppId, setQqAppId] = useState('');
  const [qqAppSecret, setQqAppSecret] = useState('');

  // Discord
  const [discordBotToken, setDiscordBotToken] = useState('');

  // WeChat
  const [wechatQROpen, setWechatQROpen] = useState(false);
  const [wechatConnected, setWechatConnected] = useState(false);

  useEffect(() => {
    if (user === null && initialized === true) {
      navigate('/login', { replace: true });
    }
  }, [user, initialized, navigate]);

  // Check if user already has a legacy feishu user-im config
  useEffect(() => {
    if (!enableMultiBot) return;
    api
      .get<{ appId?: string; enabled?: boolean }>('/api/config/user-im/feishu')
      .then((data) => {
        setHasLegacyFeishu(!!(data.appId && data.enabled !== false));
      })
      .catch(() => {});
  }, [enableMultiBot]);

  const handleMigrateToBot = async () => {
    setMigrating(true);
    try {
      await api.post('/api/config/setup/migrate-feishu-to-bot', {});
      showToast('迁移成功', '飞书配置已迁移为 Bot，请前往 Bots 页管理', 4000);
      navigate('/bots');
    } catch (err) {
      showToast('迁移失败', getErrorMessage(err, '迁移失败，请稍后重试'), 4000);
    } finally {
      setMigrating(false);
    }
  };

  const handleSkip = () => {
    navigate('/chat', { replace: true });
  };

  const handleSave = async () => {
    setError(null);

    const hasFeishu = feishuAppId.trim() || feishuAppSecret.trim();
    const hasTelegram = telegramBotToken.trim();
    const hasQQ = qqAppId.trim() || qqAppSecret.trim();
    const hasDiscord = discordBotToken.trim();

    if (!hasFeishu && !hasTelegram && !hasQQ && !hasDiscord) {
      navigate('/chat', { replace: true });
      return;
    }

    if (feishuAppSecret.trim() && !feishuAppId.trim()) {
      setError('填写飞书 Secret 时，App ID 也必须填写');
      return;
    }
    if (feishuAppId.trim() && !feishuAppSecret.trim()) {
      setError('填写飞书 App ID 时，App Secret 也必须填写');
      return;
    }
    if (qqAppSecret.trim() && !qqAppId.trim()) {
      setError('填写 QQ Secret 时，App ID 也必须填写');
      return;
    }
    if (qqAppId.trim() && !qqAppSecret.trim()) {
      setError('填写 QQ App ID 时，App Secret 也必须填写');
      return;
    }

    setSaving(true);
    try {
      if (hasFeishu) {
        const payload: Record<string, string | boolean> = { enabled: true };
        if (feishuAppId.trim()) payload.appId = feishuAppId.trim();
        if (feishuAppSecret.trim()) payload.appSecret = feishuAppSecret.trim();
        await api.put('/api/config/user-im/feishu', payload);
      }

      if (hasTelegram) {
        await api.put('/api/config/user-im/telegram', {
          botToken: telegramBotToken.trim(),
          enabled: true,
        });
      }

      if (hasQQ) {
        await api.put('/api/config/user-im/qq', {
          appId: qqAppId.trim(),
          appSecret: qqAppSecret.trim(),
          enabled: true,
        });
      }

      if (hasDiscord) {
        await api.put('/api/config/user-im/discord', {
          botToken: discordBotToken.trim(),
          enabled: true,
        });
      }

      navigate('/chat', { replace: true });
    } catch (err) {
      setError(getErrorMessage(err, '保存消息通道配置失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="h-screen bg-background overflow-y-auto p-4">
      <div className="w-full max-w-2xl mx-auto space-y-5">
        <div className="text-center">
          <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
            <MessageSquare className="w-6 h-6 text-primary" />
          </div>
          <h1 className="text-2xl font-bold text-foreground mb-2">
            配置消息通道（可选）
          </h1>
          <p className="text-sm text-muted-foreground">
            绑定飞书或 Telegram，即可通过 IM 与 AI
            对话。跳过后也可在设置中随时配置。
          </p>
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-error-bg border border-error/30 text-error text-sm">
            {error}
          </div>
        )}

        {/* Feishu */}
        <Card className="shadow-sm">
          <CardContent>
            <h2 className="text-base font-semibold text-foreground mb-3">
              飞书
            </h2>

            {/* Multi-Bot migration prompt */}
            {enableMultiBot && (
              <div className="mb-4 p-4 rounded-lg border border-teal-500/30 bg-teal-500/5">
                <div className="flex items-start gap-3">
                  <Bot
                    size={20}
                    className="text-teal-500 mt-0.5 flex-shrink-0"
                  />
                  <div className="flex-1">
                    <div className="font-medium text-sm text-foreground">
                      推荐：使用 Bot 管理飞书连接
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Bot 支持多 Agent 协作场景，可为每个 Bot
                      独立配置身份与角色。
                    </p>
                    <div className="mt-2.5 flex flex-wrap gap-2">
                      <Button size="sm" onClick={() => navigate('/bots')}>
                        <Bot className="w-3.5 h-3.5" />
                        前往 Bots 页创建
                      </Button>
                      {hasLegacyFeishu && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={handleMigrateToBot}
                          disabled={migrating}
                        >
                          {migrating && (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          )}
                          从当前飞书配置迁移
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            <p className="text-xs text-muted-foreground mb-3">
              {enableMultiBot
                ? '或直接在此填写飞书应用凭证（系统级配置，非推荐方式）：'
                : '填写你的飞书应用凭证，绑定后即可在飞书中与 AI 对话。'}
            </p>
            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <Label className="mb-1">App ID</Label>
                <Input
                  type="text"
                  value={feishuAppId}
                  onChange={(e) => setFeishuAppId(e.target.value)}
                  placeholder="输入飞书 App ID"
                />
              </div>
              <div>
                <Label className="mb-1">App Secret</Label>
                <Input
                  type="password"
                  value={feishuAppSecret}
                  onChange={(e) => setFeishuAppSecret(e.target.value)}
                  placeholder="输入飞书 App Secret"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Telegram */}
        <Card className="shadow-sm">
          <CardContent>
            <h2 className="text-base font-semibold text-foreground mb-3">
              Telegram
            </h2>
            <p className="text-xs text-muted-foreground mb-3">
              填写 Telegram Bot Token，绑定后即可在 Telegram 中与 AI 对话。
            </p>
            <div>
              <Label className="mb-1">Bot Token</Label>
              <Input
                type="password"
                value={telegramBotToken}
                onChange={(e) => setTelegramBotToken(e.target.value)}
                placeholder="输入 Telegram Bot Token"
              />
            </div>
          </CardContent>
        </Card>

        {/* QQ */}
        <Card className="shadow-sm">
          <CardContent>
            <h2 className="text-base font-semibold text-foreground mb-3">QQ</h2>
            <p className="text-xs text-muted-foreground mb-3">
              填写 QQ Bot 应用凭证，绑定后即可在 QQ 中与 AI 对话。
            </p>
            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <Label className="mb-1">App ID</Label>
                <Input
                  type="text"
                  value={qqAppId}
                  onChange={(e) => setQqAppId(e.target.value)}
                  placeholder="输入 QQ Bot App ID"
                />
              </div>
              <div>
                <Label className="mb-1">App Secret</Label>
                <Input
                  type="password"
                  value={qqAppSecret}
                  onChange={(e) => setQqAppSecret(e.target.value)}
                  placeholder="输入 QQ Bot App Secret"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Discord */}
        <Card className="shadow-sm">
          <CardContent>
            <h2 className="text-base font-semibold text-foreground mb-3">
              Discord
            </h2>
            <p className="text-xs text-muted-foreground mb-3">
              填写 Discord Bot Token，绑定后即可在 Discord 中与 AI 对话。
            </p>
            <div>
              <Label className="mb-1">Bot Token</Label>
              <Input
                type="password"
                value={discordBotToken}
                onChange={(e) => setDiscordBotToken(e.target.value)}
                placeholder="输入 Discord Bot Token"
              />
            </div>
          </CardContent>
        </Card>

        {/* WeChat */}
        <section className="bg-card rounded-xl border border-border shadow-sm p-5">
          <h2 className="text-base font-semibold text-foreground mb-3">微信</h2>
          <p className="text-xs text-muted-foreground mb-3">
            扫描二维码登录微信，绑定后即可在微信中与 AI 对话。
          </p>
          {wechatConnected ? (
            <div className="flex items-center gap-2 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-700 font-medium">
              微信已登录
            </div>
          ) : (
            <Button variant="outline" onClick={() => setWechatQROpen(true)}>
              <QrCode className="w-4 h-4" />
              扫码登录微信
            </Button>
          )}
        </section>

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-3 justify-end">
          <Button variant="outline" onClick={handleSkip}>
            <SkipForward className="w-4 h-4" />
            跳过
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            保存并继续
            <ArrowRight className="w-4 h-4" />
          </Button>
        </div>

        <WeChatQRDialog
          isOpen={wechatQROpen}
          onClose={() => setWechatQROpen(false)}
          onSuccess={() => {
            setWechatQROpen(false);
            setWechatConnected(true);
          }}
        />
      </div>
    </div>
  );
}
