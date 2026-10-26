import 'package:intl/intl.dart';
import 'package:timezone/timezone.dart' as tz;

DateTime patientNow(String timezone, {DateTime? instant}) =>
    tz.TZDateTime.from(instant ?? DateTime.now(), tz.getLocation(timezone));
String dateKey(DateTime date) => DateFormat('yyyy-MM-dd').format(date);
String displayDate(String value) =>
    DateFormat.yMMMd().format(DateTime.parse(value));
String patientTime(DateTime instant, String timezone) =>
    DateFormat.jm().format(patientNow(timezone, instant: instant));
String prettyTime(String time) {
  final parts = time.split(':');
  return DateFormat.jm()
      .format(DateTime(2000, 1, 1, int.parse(parts[0]), int.parse(parts[1])));
}

const weekdayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
String scheduleDays(List<int> days) =>
    days.isEmpty ? 'Every day' : days.map((d) => weekdayLabels[d]).join(', ');
