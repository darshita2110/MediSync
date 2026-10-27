import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:uuid/uuid.dart';
import 'api.dart';
import 'models.dart';
import 'notification_contract.dart';
import 'session.dart';

const _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true));
const _identityKey = 'medisync.push.installation.v1';
const _bindingKey = 'medisync.push.binding.v1';
const _channel = AndroidNotificationChannel('medisync_care', 'Care reminders',
    description: 'Dose reminders and missed-dose family alerts',
    importance: Importance.high);

Future<Json> _readBinding() async {
  final value = await _storage.read(key: _bindingKey);
  return value == null ? <String, dynamic>{} : jsonDecode(value) as Json;
}

Future<void> _showPush(RemoteMessage message, {bool background = false}) async {
  final data = Map<String, dynamic>.from(message.data);
  final binding = await _readBinding();
  if (!acceptsPush(data, binding, DateTime.now())) return;
  final session = await SecureSessionStore().read();
  if (session?.userId != binding['user_id']) return;
  final id = data['notification_id'] as String;
  final receipt = 'medisync.push.received.$id';
  if (await _storage.read(key: receipt) != null) return;
  final plugin = FlutterLocalNotificationsPlugin();
  if (background) {
    await plugin.initialize(const InitializationSettings(
        android: AndroidInitializationSettings('ic_stat_medisync')));
  }
  await plugin.show(
      notificationDisplayId(id),
      'MediSync care alert',
      data['kind'] == 'missed'
          ? 'A dose needs a family review. Open MediSync for details.'
          : 'A scheduled dose needs a response. Open MediSync to review.',
      NotificationDetails(
          android: AndroidNotificationDetails(_channel.id, _channel.name,
              channelDescription: _channel.description,
              importance: Importance.high,
              priority: Priority.high,
              onlyAlertOnce: true,
              actions: data['kind'] == 'reminder'
                  ? const [
                      AndroidNotificationAction('taken', 'Taken',
                          showsUserInterface: true, cancelNotification: false),
                      AndroidNotificationAction('snooze', 'Snooze',
                          showsUserInterface: true, cancelNotification: false),
                      AndroidNotificationAction('skipped', 'Skip',
                          showsUserInterface: true, cancelNotification: false),
                    ]
                  : null)),
      payload: jsonEncode(data));
  // Separate keys avoid a background-isolate write overwriting enrollment/logout.
  await _storage.write(key: receipt, value: data['expires_at'] as String);
}

@pragma('vm:entry-point')
Future<void> receivePushInBackground(RemoteMessage message) async {
  try {
    await Firebase.initializeApp();
    await _showPush(message, background: true);
  } catch (_) {
    /* No action is recorded if storage/permissions are unavailable. */
  }
}

class PushController extends ChangeNotifier implements SessionNotifications {
  PushController(this.repo);
  final Repository repo;
  Session? _session;
  bool available = false, enabled = false, busy = false;
  String status =
      'Phone notifications are available on the configured Android app.';
  NotificationIntent? _intent;
  NotificationIntent? takeIntent() {
    final result = _intent;
    _intent = null;
    return result;
  }

  StreamSubscription<RemoteMessage>? _foreground;
  StreamSubscription<String>? _tokens;
  final _local = FlutterLocalNotificationsPlugin();
  Future<void> _tail = Future<void>.value();
  bool _disposed = false;
  void _changed() {
    if (!_disposed) notifyListeners();
  }

  Future<T> _serial<T>(Future<T> Function() work) {
    final result = _tail.then((_) => work());
    _tail = result.then<void>((_) {}, onError: (Object _) {});
    return result;
  }

  Future<void> initialize() async {
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) return;
    try {
      await Firebase.initializeApp();
      FirebaseMessaging.onBackgroundMessage(receivePushInBackground);
      await _local.initialize(
          const InitializationSettings(
              android: AndroidInitializationSettings('ic_stat_medisync')),
          onDidReceiveNotificationResponse: (response) {
        unawaited(_handleResponse(response));
      });
      await _local
          .resolvePlatformSpecificImplementation<
              AndroidFlutterLocalNotificationsPlugin>()
          ?.createNotificationChannel(_channel);
      available = true;
      _foreground = FirebaseMessaging.onMessage.listen((message) {
        unawaited(_showPush(message).catchError((Object _) {}));
      });
      _tokens = FirebaseMessaging.instance.onTokenRefresh.listen((_) {
        final session = _session;
        if (enabled && session != null) unawaited(onSignedIn(session));
      });
      final launch = await _local.getNotificationAppLaunchDetails();
      if (launch?.notificationResponse != null) {
        await _handleResponse(launch!.notificationResponse!);
      }
    } catch (_) {
      status =
          'Phone notifications could not start. The care inbox is still available.';
    }
    _changed();
  }

  Future<void> _handleResponse(NotificationResponse response) async {
    try {
      final data = jsonDecode(response.payload ?? '{}') as Json;
      final intent =
          NotificationIntent.parse(data, action: response.actionId ?? '');
      final binding = await _readBinding();
      final signedIn = await SecureSessionStore().read();
      if (signedIn?.userId != binding['user_id']) return;
      if (intent == null ||
          binding['enabled'] != true ||
          binding['binding_id'] != intent.bindingId) {
        return;
      }
      _intent = intent;
      _changed();
    } catch (_) {/* Malformed or previous-account notification. */}
  }

  Future<void> _pruneReceipts() async {
    final values = await _storage.readAll();
    final now = DateTime.now();
    for (final entry in values.entries) {
      if (entry.key.startsWith('medisync.push.received.')) {
        final expiry = DateTime.tryParse(entry.value);
        if (expiry == null || !expiry.isAfter(now)) {
          await _storage.delete(key: entry.key);
        }
      }
    }
  }

  Future<Json> _identity() async {
    final value = await _storage.read(key: _identityKey);
    if (value != null) return jsonDecode(value) as Json;
    final random = Random.secure();
    final identity = <String, dynamic>{
      'id': const Uuid().v4(),
      'installation_secret': List.generate(
              32, (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'))
          .join()
    };
    await _storage.write(key: _identityKey, value: jsonEncode(identity));
    return identity;
  }

  Future<void> _register(Session session, Json binding) async {
    final identity = await _identity();
    final token = await FirebaseMessaging.instance.getToken();
    if (token == null) {
      throw const ApiException(
          'No push token is available. Check Google Play services and try again.');
    }
    if (_session?.token != session.token || repo.api.token != session.token) {
      return;
    }
    Future<Json> enroll(String currentToken) =>
        repo.registerPush(identity['id'] as String, {
          'installation_secret': identity['installation_secret'],
          'binding_id': binding['binding_id'],
          'platform': 'android',
          'token': currentToken,
        });
    Json result;
    try {
      result = await enroll(token);
    } on ApiException catch (error) {
      if (error.status != 409) rethrow;
      await FirebaseMessaging.instance.deleteToken();
      final refreshed = await FirebaseMessaging.instance.getToken();
      if (refreshed == null) {
        throw const ApiException(
            'The phone token could not be refreshed. Please try enabling notifications again.');
      }
      if (_session?.token != session.token || repo.api.token != session.token) {
        return;
      }
      result = await enroll(refreshed);
    }
    if (_session?.userId != session.userId) return;
    enabled = true;
    status = result['push_configured'] == true
        ? 'Enabled on this phone. Delivery still depends on the reminder service and connection.'
        : 'Enabled on this phone. Server delivery still needs configuration; use the care inbox meanwhile.';
  }

  @override
  Future<void> onSignedIn(Session session) {
    _session = session;
    return _serial(() async {
      if (!available || _session?.token != session.token) return;
      try {
        await _pruneReceipts();
        final binding = await _readBinding();
        if (binding['enabled'] != true ||
            binding['user_id'] != session.userId) {
          enabled = false;
          await _local.cancelAll();
          status =
              'Phone notifications are off. Enable them when you are ready.';
        } else {
          final settings =
              await FirebaseMessaging.instance.getNotificationSettings();
          if (settings.authorizationStatus != AuthorizationStatus.authorized) {
            enabled = false;
            status = 'Notification permission is off in Android settings.';
          } else {
            await _register(session, binding);
          }
        }
      } catch (_) {
        status =
            'Could not reconnect phone notifications. Open notification settings to retry.';
      }
      _changed();
    });
  }

  Future<void> enable() => _serial(() async {
        final session = _session;
        if (!available || session == null || busy) return;
        busy = true;
        _changed();
        try {
          final settings = await FirebaseMessaging.instance.requestPermission();
          if (settings.authorizationStatus != AuthorizationStatus.authorized) {
            status =
                'Permission was not granted. You can enable notifications in Android settings.';
            return;
          }
          await FirebaseMessaging.instance.setAutoInitEnabled(true);
          final binding = <String, dynamic>{
            'user_id': session.userId,
            'binding_id': const Uuid().v4(),
            'enabled': true
          };
          await _storage.write(key: _bindingKey, value: jsonEncode(binding));
          await _local.cancelAll();
          await _register(session, binding);
        } catch (e) {
          enabled = false;
          final binding = await _readBinding();
          await _storage.write(
              key: _bindingKey,
              value: jsonEncode({...binding, 'enabled': false}));
          status = e is ApiException
              ? e.message
              : 'Could not enable notifications. Check your connection and retry.';
        } finally {
          busy = false;
          _changed();
        }
      });

  Future<void> disable() => _serial(() => _disable(_session));

  Future<void> _disable(Session? session) async {
    final binding = await _readBinding();
    await _storage.write(
        key: _bindingKey, value: jsonEncode({...binding, 'enabled': false}));
    enabled = false;
    _intent = null;
    if (available) {
      await _local.cancelAll();
      try {
        await FirebaseMessaging.instance.setAutoInitEnabled(false);
      } catch (_) {}
    }
    status = 'Phone notifications are off. Your care inbox is still available.';
    _changed();
    if (session == null ||
        repo.api.token != session.token ||
        binding['binding_id'] == null) {
      return;
    }
    final identity = await _identity();
    try {
      await repo.unregisterPush(identity['id'] as String, {
        'installation_secret': identity['installation_secret'],
        'binding_id': binding['binding_id'],
      }).timeout(const Duration(seconds: 3));
    } catch (_) {
      // The local binding is disabled first. Old payloads are discarded even
      // when an offline sign-out cannot reach the server.
    }
  }

  @override
  Future<void> onSignedOut() {
    final previous = _session;
    _session = null;
    return _serial(() => _disable(previous));
  }

  @override
  void dispose() {
    _disposed = true;
    unawaited(_foreground?.cancel());
    unawaited(_tokens?.cancel());
    super.dispose();
  }
}
