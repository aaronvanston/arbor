import { memo, type FunctionComponent, type NamedExoticComponent, type SVGProps } from 'react';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import * as stroke from '@hugeicons/core-free-icons';
import * as duotone from 'arbor-duotone-icons';

/**
 * Arbor's icons: Hugeicons' stroke rounded set, under the Lucide names the app used before. The pages a sidebar row
 * can select also carry Hugeicons Pro's duotone drawing, shown while the row is selected. The Pro set installs only
 * with HUGEICONS_LICENSE_KEY in the repo's .env; without it `arbor-duotone-icons` is the free stroke set again.
 */

/** Line weight on the 24-unit grid: Hugeicons draws at 1.5, a little light beside text at 16px. */
export const ICON_STROKE = 1.75;

export type AppIconProps = Omit<SVGProps<SVGSVGElement>, 'ref' | 'strokeWidth'> & {
  size?: number | string;
  strokeWidth?: number;
  /** Draws the duotone version, for the selected sidebar row. Icons without one stay as they are. */
  selected?: boolean;
};
/** One of the icons below, or anything drawn in one's place (a test's stand-in). */
export type AppIcon = NamedExoticComponent<AppIconProps> | FunctionComponent<AppIconProps>;

/**
 * Memoized: an icon's props are nearly always a class name, so a row or button rendering again for its own reasons
 * leaves its icons as they were (they were most of what an idle minute rendered).
 */
function icon(line: IconSvgElement, filled?: IconSvgElement): NamedExoticComponent<AppIconProps> {
  return memo(function Icon({ selected = false, strokeWidth = ICON_STROKE, ...props }: AppIconProps) {
    return <HugeiconsIcon icon={selected && filled ? filled : line} strokeWidth={strokeWidth} {...props} />;
  });
}

export const Activity = icon(stroke.ActivityIcon, duotone.ActivityIcon);
export const AlarmClock = icon(stroke.AlarmClockIcon);
export const AlarmClockOff = icon(stroke.AlarmClockOffIcon);
export const AlertCircle = icon(stroke.AlertCircleIcon);
export const Archive = icon(stroke.ArchiveIcon, duotone.ArchiveIcon);
export const ArchiveX = icon(stroke.ArchiveXIcon);
export const ArrowDown = icon(stroke.ArrowDownIcon);
export const ArrowDownToLine = icon(stroke.ArrowDownToLineIcon);
export const ArrowLeft = icon(stroke.ArrowLeftIcon);
export const ArrowRight = icon(stroke.ArrowRightIcon);
export const ArrowRightLeft = icon(stroke.ArrowLeftRightIcon);
export const ArrowUp = icon(stroke.ArrowUpIcon);
export const ArrowUpCircle = icon(stroke.CircleArrowUp01Icon);
export const ArrowUpDown = icon(stroke.ArrowUpDownIcon);
export const ArrowUpFromLine = icon(stroke.ArrowUpFromLineIcon);
export const ArrowUpRight = icon(stroke.ArrowUpRightIcon);
export const Bell = icon(stroke.BellIcon, duotone.BellIcon);
export const BellOff = icon(stroke.BellOffIcon);
export const BellRing = icon(stroke.BellRingIcon, duotone.BellRingIcon);
export const Bot = icon(stroke.BotIcon);
export const BrainCircuit = icon(stroke.BrainCircuitIcon);
export const CalendarRange = icon(stroke.CalendarRangeIcon);
export const ChartNoAxesColumn = icon(stroke.ChartNoAxesColumnIcon, duotone.ChartNoAxesColumnIcon);
export const Check = icon(stroke.CheckIcon);
export const ChevronDown = icon(stroke.ChevronDownIcon);
export const ChevronLeft = icon(stroke.ChevronLeftIcon);
export const ChevronRight = icon(stroke.ChevronRightIcon);
export const ChevronUp = icon(stroke.ChevronUpIcon);
export const CircleAlert = icon(stroke.AlertCircleIcon);
export const CircleCheck = icon(stroke.CircleCheckIcon);
export const CircleDot = icon(stroke.CircleDotIcon);
export const CirclePause = icon(stroke.PauseCircleIcon);
export const CirclePlay = icon(stroke.PlayCircleIcon);
export const CircleX = icon(stroke.CircleXIcon);
export const Clock = icon(stroke.ClockIcon);
export const Clock3 = icon(stroke.Clock03Icon);
export const CloudAlert = icon(stroke.CloudAlertIcon);
export const Coins = icon(stroke.CoinsIcon);
export const Columns2 = icon(stroke.LayoutTwoColumnIcon);
export const Columns3 = icon(stroke.LayoutThreeColumnIcon);
export const Computer = icon(stroke.ComputerIcon);
export const Copy = icon(stroke.CopyIcon);
export const CornerDownRight = icon(stroke.CornerDownRightIcon);
export const Cpu = icon(stroke.CpuIcon);
export const Database = icon(stroke.DatabaseIcon, duotone.DatabaseIcon);
export const DatabaseZap = icon(stroke.DatabaseZapIcon);
export const Download = icon(stroke.DownloadIcon);
export const ExternalLink = icon(stroke.ExternalLinkIcon);
export const Eye = icon(stroke.EyeIcon);
export const EyeOff = icon(stroke.EyeOffIcon);
export const FileCode = icon(stroke.FileCodeIcon);
export const FileText = icon(stroke.File01Icon);
export const FilterX = icon(stroke.FilterRemoveIcon);
export const Flame = icon(stroke.FlameIcon);
export const FlaskConical = icon(stroke.FlaskConicalIcon);
export const FoldVertical = icon(stroke.FoldVerticalIcon);
export const FolderGit2 = icon(stroke.FolderGit2Icon);
export const FolderInput = icon(stroke.FolderInputIcon);
export const FolderOpen = icon(stroke.FolderOpenIcon);
export const FolderSearch = icon(stroke.FolderSearchIcon);
export const Gauge = icon(stroke.GaugeIcon);
export const GitBranch = icon(stroke.GitBranchIcon);
export const GitFork = icon(stroke.GitForkIcon);
export const GitMerge = icon(stroke.GitMergeIcon);
export const GitPullRequest = icon(stroke.GitPullRequestIcon);
export const Globe = icon(stroke.GlobeIcon);
export const Gpu = icon(stroke.GpuIcon);
export const GripVertical = icon(stroke.GripVerticalIcon);
export const Hammer = icon(stroke.HammerIcon);
export const HardDrive = icon(stroke.HardDriveIcon);
export const History = icon(stroke.HistoryIcon);
export const Hourglass = icon(stroke.HourglassIcon);
export const House = icon(stroke.Home03Icon, duotone.Home03Icon);
export const ImageIcon = icon(stroke.ImageIcon);
export const Import = icon(stroke.ImportIcon);
export const Inbox = icon(stroke.InboxIcon);
export const Info = icon(stroke.InfoIcon, duotone.InfoIcon);
export const KeyRound = icon(stroke.KeyRoundIcon, duotone.KeyRoundIcon);
export const Laptop = icon(stroke.LaptopIcon);
export const Layers = icon(stroke.LayersIcon, duotone.LayersIcon);
export const Lightbulb = icon(stroke.LightbulbIcon);
export const LineChart = icon(stroke.ChartLineIcon);
export const Link2 = icon(stroke.Link01Icon);
export const List = icon(stroke.ListIcon);
export const ListChecks = icon(stroke.ListChecksIcon);
export const ListFilter = icon(stroke.ListFilterIcon);
export const Lock = icon(stroke.LockIcon);
export const LogIn = icon(stroke.LogInIcon);
export const MemoryStick = icon(stroke.MemoryStickIcon);
export const MessageSquareMore = icon(stroke.MessageSquareMoreIcon);
export const MessagesSquare = icon(stroke.MessagesSquareIcon, duotone.MessagesSquareIcon);
export const Minus = icon(stroke.MinusIcon);
export const Monitor = icon(stroke.MonitorIcon, duotone.MonitorIcon);
export const MonitorCheck = icon(stroke.MonitorCheckIcon);
export const MonitorPlus = icon(stroke.ComputerAddIcon);
export const Moon = icon(stroke.MoonIcon);
export const MoreHorizontal = icon(stroke.MoreHorizontalIcon);
export const Network = icon(stroke.NetworkIcon, duotone.NetworkIcon);
export const PackageOpen = icon(stroke.PackageOpenIcon, duotone.PackageOpenIcon);
export const Palette = icon(stroke.PaletteIcon, duotone.PaletteIcon);
export const PanelLeft = icon(stroke.PanelLeftIcon);
export const PanelLeftClose = icon(stroke.PanelLeftCloseIcon);
export const Pause = icon(stroke.PauseIcon);
export const PauseCircle = icon(stroke.PauseCircleIcon);
export const PcCase = icon(stroke.PcCaseIcon);
export const Pencil = icon(stroke.PencilIcon);
export const Pipette = icon(stroke.PipetteIcon);
export const Pin = icon(stroke.PinIcon);
export const PinOff = icon(stroke.PinOffIcon);
export const Play = icon(stroke.PlayIcon);
export const Plus = icon(stroke.PlusIcon);
export const Power = icon(stroke.PowerIcon);
export const PowerOff = icon(stroke.PowerOffIcon);
export const Radar = icon(stroke.RadarIcon);
export const Radio = icon(stroke.RadioIcon);
export const RadioTower = icon(stroke.RadioTowerIcon);
export const RefreshCw = icon(stroke.RefreshCwIcon);
// Hugeicons' RotateCcw is drawn with a dashed tail that reads as a loader, so undo, restore and restart take the solid arrow.
export const RotateCcw = icon(stroke.Undo02Icon);
export const Route = icon(stroke.RouteIcon, duotone.RouteIcon);
export const Rows2 = icon(stroke.Rows2Icon);
export const Scan = icon(stroke.ScanIcon);
export const ScanSearch = icon(stroke.ScanSearchIcon);
export const Search = icon(stroke.SearchIcon);
export const Send = icon(stroke.SendIcon);
export const Server = icon(stroke.ServerIcon);
export const ServerCog = icon(stroke.ServerCogIcon);
export const Settings = icon(stroke.SettingsIcon);
export const Settings2 = icon(stroke.Settings02Icon, duotone.Settings02Icon);
export const Share = icon(stroke.ShareIcon);
export const ShieldCheck = icon(stroke.ShieldCheckIcon);
export const ShieldQuestionMark = icon(stroke.ShieldQuestionMarkIcon);
export const Shrink = icon(stroke.ShrinkIcon);
export const Shuffle = icon(stroke.ShuffleIcon, duotone.ShuffleIcon);
export const SlidersHorizontal = icon(stroke.SlidersHorizontalIcon, duotone.SlidersHorizontalIcon);
export const Smartphone = icon(stroke.SmartphoneIcon);
export const Sparkles = icon(stroke.SparklesIcon, duotone.SparklesIcon);
export const Square = icon(stroke.SquareIcon);
export const Sun = icon(stroke.SunIcon);
export const SunMoon = icon(stroke.SunMoonIcon);
export const Tags = icon(stroke.TagsIcon, duotone.TagsIcon);
export const TerminalSquare = icon(stroke.ComputerTerminal01Icon);
export const Thermometer = icon(stroke.ThermometerIcon);
export const TimeSchedule = icon(stroke.TimeScheduleIcon, duotone.TimeScheduleIcon);
export const Trash2 = icon(stroke.Delete02Icon);
export const TriangleAlert = icon(stroke.TriangleAlertIcon);
export const Unplug = icon(stroke.UnplugIcon);
export const UserCheck = icon(stroke.UserCheckIcon);
export const UserPlus = icon(stroke.UserPlusIcon);
export const UserRound = icon(stroke.UserRoundIcon);
export const UserRoundX = icon(stroke.UserRoundXIcon);
export const Users = icon(stroke.UsersIcon, duotone.UsersIcon);
export const Wrench = icon(stroke.WrenchIcon);
export const X = icon(stroke.XIcon);
export const Zap = icon(stroke.ZapIcon);
export const ZoomIn = icon(stroke.ZoomInIcon);
export const ZoomOut = icon(stroke.ZoomOutIcon);
