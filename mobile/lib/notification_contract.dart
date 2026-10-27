import 'models.dart';

abstract interface class SessionNotifications {
  Future<void> onSignedIn(Session session);
  Future<void> onSignedOut();
}

class NotificationIntent {
  const NotificationIntent(this.notificationId, this.bindingId, this.action);
  final String notificationId, bindingId, action;
  static NotificationIntent? parse(Json data, {String action = ''}) {
    final id = data['notification_id'], binding = data['binding_id'];
    final uuid =
        RegExp(r'^[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$');
    if (id is! String ||
        binding is! String ||
        !uuid.hasMatch(id) ||
        !uuid.hasMatch(binding) ||
        !['', 'taken', 'snooze', 'skipped'].contains(action)) {
      return null;
    }
    return NotificationIntent(id, binding, action);
  }
}

bool acceptsPush(Json data, Json binding, DateTime reference) {
  final intent = NotificationIntent.parse(data);
  final expires = DateTime.tryParse(data['expires_at'] as String? ?? '');
  return intent != null &&
      binding['enabled'] == true &&
      binding['binding_id'] == intent.bindingId &&
      binding['user_id'] is String &&
      expires != null &&
      expires.isAfter(reference) &&
      ['reminder', 'missed'].contains(data['kind']);
}

// Stable across isolates/restarts; replacing a retried delivery preserves one
// notification card. The UUID is still the authority, never this display ID.
int notificationDisplayId(String id) {
  var hash = 2166136261;
  for (final unit in id.codeUnits) {
    hash = ((hash ^ unit) * 16777619) & 0x7fffffff;
  }
  return hash;
}
