export function liveValue(value) {
  return typeof value?.get === 'function' ? value.get() : value;
}

const formatters = new Map();
export function maintenanceWindow(config, now = new Date()) {
  const enabled = liveValue(config.enabled) !== false;
  const automatic = liveValue(config.automaticMaintenance) !== false;
  const offPeakOnly = liveValue(config.offPeakOnly) === true;
  const schedule = liveValue(config.offPeakSchedule);
  if (!enabled || !automatic || !offPeakOnly) return { enabled, automatic, offPeakOnly, allowed: enabled && automatic };
  const timeZone = schedule.timeZone;
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(now).map(part => [part.type, part.value]));
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  const weekend = schedule.weekends && ['Sat', 'Sun'].includes(parts.weekday);
  const allowed = weekend || schedule.windows.some(window => {
    const start = clockMinute(window.start), end = clockMinute(window.end);
    return start < end ? minute >= start && minute < end : minute >= start || minute < end;
  });
  return { enabled, automatic, offPeakOnly, allowed, timeZone };
}

export function clockMinute(value) {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

export function validateSchedule(schedule) {
  if (!schedule || !Array.isArray(schedule.windows) || !schedule.windows.length) throw new Error('至少配置一个可整理时段。');
  new Intl.DateTimeFormat('en', { timeZone: schedule.timeZone });
  for (const window of schedule.windows) {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(window.start)
      || !/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/u.test(window.end)
      || window.start === window.end) throw new Error('整理时段的起止时间无效。');
  }
  return schedule;
}
