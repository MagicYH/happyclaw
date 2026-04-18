import { MessageCircle, Clock4, Puzzle, Wallet, User, Bot } from 'lucide-react';

export const baseNavItems = [
  { path: '/chat', icon: MessageCircle, label: '工作台' },
  { path: '/skills', icon: Puzzle, label: 'Skill' },
  { path: '/tasks', icon: Clock4, label: '任务' },
  { path: '/bots', icon: Bot, label: 'Bots', requiresMultiBot: true },
  { path: '/billing', icon: Wallet, label: '账单', requiresBilling: true },
  { path: '/settings', icon: User, label: '设置' },
];

export function filterNavItems(
  billingEnabled: boolean,
  enableMultiBot = false,
) {
  return baseNavItems.filter((item) => {
    if (item.requiresBilling && !billingEnabled) return false;
    if (item.requiresMultiBot && !enableMultiBot) return false;
    return true;
  });
}
