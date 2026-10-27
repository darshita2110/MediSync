import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:medisync/api.dart';
import 'package:medisync/models.dart';
import 'package:medisync/notification_contract.dart';
import 'package:medisync/session.dart';
import 'package:medisync/ui/notification_review_page.dart';
import 'package:medisync/ui/shared.dart';
import 'package:timezone/data/latest_all.dart' as tz;
import 'fake_server.dart';

const id = '10000000-0000-0000-0000-000000000001';
const bindingId = '20000000-0000-0000-0000-000000000001';

void main() {
  setUpAll(tz.initializeTimeZones);
  test('push accepts only an enabled current binding before expiry', () {
    final now = DateTime.utc(2026, 10, 26, 8);
    final data = <String, dynamic>{
      'notification_id': id,
      'binding_id': bindingId,
      'kind': 'reminder',
      'expires_at': now.add(const Duration(minutes: 15)).toIso8601String()
    };
    final binding = <String, dynamic>{
      'binding_id': bindingId,
      'enabled': true,
      'user_id': 'user'
    };
    expect(acceptsPush(data, binding, now), isTrue);
    expect(acceptsPush(data, {...binding, 'enabled': false}, now), isFalse);
    expect(acceptsPush(data, {...binding, 'binding_id': id}, now), isFalse);
    expect(acceptsPush(data, binding, now.add(const Duration(minutes: 15))),
        isFalse);
    expect(acceptsPush({...data, 'kind': 'unknown'}, binding, now), isFalse);
  });
  test('notification routes reject malformed identifiers and unknown actions',
      () {
    final data = <String, dynamic>{
      'notification_id': id,
      'binding_id': bindingId
    };
    expect(NotificationIntent.parse(data, action: 'taken')?.action, 'taken');
    expect(NotificationIntent.parse(data, action: 'delete'), isNull);
    expect(
        NotificationIntent.parse({...data, 'notification_id': '../patients'}),
        isNull);
    expect(NotificationIntent.parse({...data, 'binding_id': null}), isNull);
  });
  test('retried delivery keeps a stable local notification ID', () {
    expect(notificationDisplayId(id), notificationDisplayId(id));
    expect(notificationDisplayId(id), isNot(notificationDisplayId(bindingId)));
    expect(notificationDisplayId(id), greaterThanOrEqualTo(0));
  });
  test(
      'notification cleanup runs while sign-out still has the authenticated session',
      () async {
    final api = ApiClient(baseUrl: Uri.parse('https://api.example.test'));
    final store = MemorySessionStore();
    const saved = Session(
        token: 'test',
        userId: 'user',
        email: 'test@example.test',
        name: 'Test');
    await store.save(saved);
    final hook = RecordingNotifications(() async {
      expect(api.token, saved.token);
      expect((await store.read())?.userId, saved.userId);
    });
    final controller =
        SessionController(Repository(api), store, notifications: hook);
    addTearDown(controller.dispose);
    await controller.initialize();
    await controller.signOut();
    expect(hook.events, ['signed-in', 'signed-out']);
    expect(await store.read(), isNull);
    expect(api.token, isNull);
  });
  testWidgets(
      'Taken notification opens a review and never silently records a dose',
      (tester) async {
    tester.view.physicalSize = const Size(430, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final server = FakeServer();
    final api = ApiClient(
        baseUrl: Uri.parse('https://api.example.test'),
        transport: MockClient((request) async {
          if (request.url.path == '/api/notifications/$id') {
            return http.Response(
                jsonEncode({
                  'notification': {
                    ...server.dose,
                    'id': id,
                    'dose_id': 'dose-1',
                    'patient_id': FakeServer.patientId,
                    'patient_name': 'Asha Rao',
                    'timezone': 'Asia/Kolkata',
                    'role': 'owner',
                    'kind': 'reminder',
                    'created_at': DateTime.now().toUtc().toIso8601String(),
                    'read_at': null
                  }
                }),
                200);
          }
          return server.handle(request);
        }));
    addTearDown(api.close);
    await tester.pumpWidget(MaterialApp(
        theme: appTheme(),
        home: NotificationReviewPage(
            repo: Repository(api),
            intent: const NotificationIntent(id, bindingId, 'taken'))));
    await tester.pumpAndSettle();
    expect(server.requests.where((r) => r.method == 'PATCH'), isEmpty);
    expect(find.text('Example medicine'), findsOneWidget);
    expect(find.textContaining('Selected action: Taken'), findsOneWidget);
    await tester.ensureVisible(find.text('Taken'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Taken'));
    await tester.pumpAndSettle();
    expect(server.doseStatus, 'taken');
    expect(find.textContaining('Recorded by Priya'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}

class RecordingNotifications implements SessionNotifications {
  RecordingNotifications(this.beforeCleanup);
  final Future<void> Function() beforeCleanup;
  final events = <String>[];
  @override
  Future<void> onSignedIn(Session session) async {
    events.add('signed-in');
  }

  @override
  Future<void> onSignedOut() async {
    events.add('signed-out');
    await beforeCleanup();
  }
}
