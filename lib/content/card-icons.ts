import { createElement, type ReactNode } from 'react';
import {
  Activity, Archive, ArrowRightCircle, BadgeCheck, BookOpen, Boxes, CalendarClock, CheckCheck,
  ClipboardCheck, ClipboardList, CloudUpload, Cpu, Database, FileCheck, FilePen, FileStack,
  Files, FolderOpen, Gauge, GitBranchPlus, GitMerge, Globe, HardDrive, History, House, KeyRound,
  Layers3, LifeBuoy, ListChecks, ListTodo, MessageSquareWarning, Network, Package, RotateCcw,
  Route, Rss, Server, Settings2, Shield, ShieldAlert, ShieldCheck, Siren, Terminal, ThumbsUp,
  TriangleAlert, type LucideIcon,
} from 'lucide-react';

const icons = {
  activity: Activity, archive: Archive, 'arrow-right-circle': ArrowRightCircle, 'badge-check': BadgeCheck,
  'book-open': BookOpen, boxes: Boxes, 'calendar-clock': CalendarClock, 'check-check': CheckCheck,
  'clipboard-check': ClipboardCheck, 'clipboard-list': ClipboardList, 'cloud-upload': CloudUpload,
  cpu: Cpu, database: Database, 'file-check': FileCheck, 'file-pen': FilePen, 'file-stack': FileStack,
  files: Files, 'folder-open': FolderOpen, gauge: Gauge, 'git-branch-plus': GitBranchPlus,
  'git-merge': GitMerge, globe: Globe, 'hard-drive': HardDrive, history: History, house: House,
  'key-round': KeyRound, 'layers-3': Layers3, 'life-buoy': LifeBuoy, 'list-checks': ListChecks,
  'list-todo': ListTodo, 'message-square-warning': MessageSquareWarning, network: Network,
  package: Package, 'rotate-ccw': RotateCcw, route: Route, rss: Rss, server: Server,
  'settings-2': Settings2, shield: Shield, 'shield-alert': ShieldAlert, 'shield-check': ShieldCheck,
  siren: Siren, terminal: Terminal, 'thumbs-up': ThumbsUp, 'triangle-alert': TriangleAlert,
} satisfies Record<string, LucideIcon>;

export function resolveCardIcon(icon: ReactNode): ReactNode {
  if (typeof icon !== 'string') return icon;
  const Icon = icons[icon as keyof typeof icons];
  return Icon ? createElement(Icon, { 'aria-hidden': true }) : undefined;
}
