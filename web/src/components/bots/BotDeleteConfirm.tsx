import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { Bot } from '@/stores/bots';

interface Props {
  bot: Bot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirmed?: () => Promise<void> | void;
}

export function BotDeleteConfirm({
  bot,
  open,
  onOpenChange,
  onConfirmed,
}: Props) {
  const [deleting, setDeleting] = useState(false);

  const handleConfirm = async () => {
    setDeleting(true);
    try {
      await onConfirmed?.();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(v) => !v && onOpenChange(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除 Bot "{bot.name}"？</AlertDialogTitle>
          <AlertDialogDescription>
            执行软删除：连接将断开，但文件和凭证保留 30 天可恢复。30
            天后系统会自动硬删除。 如需立即彻底删除，请联系管理员。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => onOpenChange(false)}>
            取消
          </AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm} disabled={deleting}>
            {deleting ? '删除中...' : '确认删除'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
