import type {
  AppUpdateInfo,
  AppUpdateTask,
  ExceptionReport,
  GuiSettings,
  PhoneAlert,
  PhoneAlertRoute,
  PhoneAlertSecret,
  PhoneAlertSecretStatus,
  ProductAnalyticsInput,
  ProductAnalyticsSettings,
  ProductEvent,
  SoftwareSettings,
  SoftwareSettingsInput,
  SystemLocale,
  ZoomLevel,
} from './types';

/** The app itself: its settings, window, tray, updates, phone alerts and saved pages. */
export type AppCommands = {
  get_gui_settings: { result: GuiSettings };
  get_software_settings: { result: SoftwareSettings };
  save_software_settings: { args: { settings: SoftwareSettingsInput }; result: SoftwareSettings };
  system_locale: { result: SystemLocale | null };
  frontend_ready: { args: { theme?: string | null }; result: void };
  set_quit_guard: { args: { enabled: boolean }; result: void };
  get_zoom_level: { result: ZoomLevel };
  set_zoom_level: { args: { step: number }; result: ZoomLevel };
  open_external_url: { args: { url: string }; result: void };

  get_product_analytics: { result: ProductAnalyticsSettings };
  set_product_analytics: { args: { settings: ProductAnalyticsInput }; result: ProductAnalyticsSettings };
  mark_product_analytics_notice_shown: { result: ProductAnalyticsSettings };
  track_event: { args: { event: ProductEvent }; result: void };
  report_exception: { args: { report: ExceptionReport }; result: void };

  set_tray_lines: { args: { section: string; lines: string[] }; result: void };
  set_tray_status: { args: { indicator: string }; result: void };
  set_tray_unread: { args: { count: number }; result: void };
  set_tray_waiting: { args: { count: number }; result: void };

  check_app_update: { result: AppUpdateInfo };
  start_app_update: { result: void };
  cancel_app_update: { result: void };
  get_app_update_task: { result: AppUpdateTask };

  get_phone_alert_secrets: { result: PhoneAlertSecretStatus };
  set_phone_alert_secret: { args: { secret: PhoneAlertSecret; value: string }; result: PhoneAlertSecretStatus };
  send_phone_alert: { args: { route: PhoneAlertRoute; alert: PhoneAlert }; result: void };

  save_digest_page: { args: { fileName: string; html: string; fileType: string }; result: string | null };
  open_saved_page: { args: { path: string; reveal: boolean }; result: void };
};
