import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:medisync/api.dart';
import 'package:medisync/calendar.dart';
import 'package:medisync/config.dart';
import 'package:medisync/models.dart';
import 'package:medisync/session.dart';
import 'package:timezone/data/latest_all.dart' as tz;

const session = Session(
    token: 'test-token',
    userId: 'user-1',
    email: 'care@example.com',
    name: 'Caregiver');

void main() {
  setUpAll(tz.initializeTimeZones);

  test('API sends JSON and bearer tokens only on authenticated calls',
      () async {
    final requests = <http.Request>[];
    final api = ApiClient(
        baseUrl: Uri.parse('https://api.example.test/'),
        transport: MockClient((request) async {
          requests.add(request);
          return http.Response(jsonEncode({'label': 'दवा'}), 200,
              headers: {'content-type': 'application/json; charset=utf-8'});
        }));
    addTearDown(api.close);
    api.token = 'token';
    final result =
        await api.request('POST', 'patients', body: {'full_name': 'Asha'});
    await api.request('POST', 'auth/login',
        body: {'email': 'care@example.com'}, authenticated: false);
    expect(result['label'], 'दवा');
    expect(
        requests.first.url.toString(), 'https://api.example.test/api/patients');
    expect(requests.first.headers['Authorization'], 'Bearer token');
    expect(requests.first.headers['Content-Type'], 'application/json');
    expect(jsonDecode(requests.first.body), {'full_name': 'Asha'});
    expect(requests.last.headers.containsKey('Authorization'), isFalse);
  });

  test('non-JSON service failures become displayable errors', () async {
    final api = ApiClient(
        baseUrl: Uri.parse('https://api.example.test'),
        transport: MockClient(
            (_) async => http.Response('<html>Bad gateway</html>', 502)));
    addTearDown(api.close);
    await expectLater(
        api.request('GET', 'patients'),
        throwsA(isA<ApiException>().having(
            (e) => e.message, 'message', contains('unexpected response'))));
  });

  test('mutations time out without automatic retries', () async {
    var count = 0;
    final response = Completer<http.Response>();
    final api = ApiClient(
        baseUrl: Uri.parse('https://api.example.test'),
        timeout: const Duration(milliseconds: 10),
        transport: MockClient((_) {
          count++;
          return response.future;
        }));
    addTearDown(api.close);
    await expectLater(
        api.request('POST', 'patients', body: {}),
        throwsA(isA<ApiException>().having(
            (e) => e.message, 'message', contains('Refresh before retrying'))));
    expect(count, 1);
    response.complete(http.Response('{}', 201));
  });

  test(
      'late unauthorized responses from an old token cannot expire a new session',
      () async {
    var expired = 0;
    final response = Completer<http.Response>();
    final api = ApiClient(
        baseUrl: Uri.parse('https://api.example.test'),
        transport: MockClient((_) => response.future));
    addTearDown(api.close);
    api.token = 'old';
    api.onUnauthorized = () => expired++;
    final request = expectLater(api.request('GET', 'patients'),
        throwsA(isA<ApiException>().having((e) => e.status, 'status', 401)));
    api.token = 'new';
    response.complete(http.Response('{"error":"Expired"}', 401));
    await request;
    expect(expired, 0);
  });

  test(
      'expired sessions clear memory and persistence; failed login does not expire a session',
      () async {
    final api = ApiClient(
        baseUrl: Uri.parse('https://api.example.test'),
        transport:
            MockClient((_) async => http.Response('{"error":"Expired"}', 401)));
    final store = MemorySessionStore();
    await store.save(session);
    final controller = SessionController(Repository(api), store);
    addTearDown(controller.dispose);
    await controller.initialize();
    await expectLater(controller.repository.login('care@example.com', 'wrong'),
        throwsA(isA<ApiException>()));
    expect(controller.session, isNotNull);
    await expectLater(
        controller.repository.patients(), throwsA(isA<ApiException>()));
    expect(controller.session, isNull);
    expect(api.token, isNull);
    await Future<void>.delayed(Duration.zero);
    expect(await store.read(), isNull);
  });

  test('failed secure persistence never leaves a login active in memory',
      () async {
    final api = ApiClient(
        baseUrl: Uri.parse('https://api.example.test'),
        transport: MockClient(
            (_) async => http.Response(jsonEncode(session.toJson()), 200)));
    final controller = SessionController(Repository(api), FailingStore());
    addTearDown(controller.dispose);
    await controller.initialize();
    await expectLater(
        controller.authenticate(
            email: 'care@example.com', password: 'test-password'),
        throwsA(isA<ApiException>()));
    expect(controller.session, isNull);
    expect(api.token, isNull);
  });

  test('an expiry clear cannot erase a freshly saved session', () async {
    final store = DelayedClearStore();
    final api = ApiClient(
        baseUrl: Uri.parse('https://api.example.test'),
        transport: MockClient((request) async => request.url.path
                .contains('/auth/')
            ? http.Response(
                jsonEncode({...session.toJson(), 'token': 'fresh-token'}), 200)
            : http.Response('{"error":"Expired"}', 401)));
    final controller = SessionController(Repository(api), store);
    addTearDown(controller.dispose);
    await controller.initialize();
    await expectLater(
        controller.repository.patients(), throwsA(isA<ApiException>()));
    final signingIn = controller.authenticate(
        email: 'care@example.com', password: 'test-password');
    await Future<void>.delayed(Duration.zero);
    expect(store.saves, 0);
    store.finishClear.complete();
    await signingIn;
    expect((await store.read())!.token, 'fresh-token');
    expect(api.token, 'fresh-token');
  });

  test('release configuration requires HTTPS and never embeds credentials', () {
    expect(() => resolveApiBase(release: true), throwsFormatException);
    expect(() => resolveApiBase(release: true, endpoint: 'http://example.test'),
        throwsFormatException);
    expect(() => resolveApiBase(endpoint: 'https://user:password@example.test'),
        throwsFormatException);
    expect(
        resolveApiBase(release: true, endpoint: 'https://api.example.test')
            .scheme,
        'https');
    expect(resolveApiBase(platform: TargetPlatform.android, web: false).host,
        '10.0.2.2');
    expect(resolveApiBase(web: true).host, 'localhost');
  });

  test('patient calendar and clock use their timezone across midnight and DST',
      () {
    final instant = DateTime.parse('2026-03-10T02:00:00Z');
    expect(dateKey(patientNow('America/New_York', instant: instant)),
        '2026-03-09');
    expect(dateKey(patientNow('Asia/Kolkata', instant: instant)), '2026-03-10');
    final before = patientNow('America/New_York',
        instant: DateTime.parse('2026-03-07T13:00:00Z'));
    final after = patientNow('America/New_York',
        instant: DateTime.parse('2026-03-08T12:00:00Z'));
    expect(before.hour, 8);
    expect(after.hour, 8);
  });

  test(
      'unknown roles fail closed and doses require explicit action eligibility',
      () {
    expect(PatientRole.parse('unexpected').canManage, isFalse);
    expect(PatientRole.viewer.canConfirm, isFalse);
    expect(
        Patient.fromJson({'id': 'p', 'full_name': 'Test', 'timezone': 'UTC'})
            .role,
        PatientRole.viewer);
    final dose = Dose.fromJson({
      'id': 'dose',
      'medicine': 'Example',
      'dose_amount': 'As recorded',
      'status': 'pending',
      'scheduled_for': '2026-10-25T08:00:00Z'
    });
    expect(dose.actionable, isFalse);
  });

  test(
      'visit medicines preserve the prescribing doctor when opening their records',
      () {
    final visit = Prescription.fromJson({
      'id': 'visit',
      'visit_date': '2026-10-25',
      'prescriber_name': 'Dr. Recorded',
      'items': [
        {
          'id': 'medicine',
          'raw_text': 'Example',
          'dose_amount': 'As recorded',
          'status': 'active',
          'start_date': '2026-10-25'
        },
      ]
    });
    expect(visit.items.single.doctor, 'Dr. Recorded');
  });
}

class FailingStore implements SessionStore {
  @override
  Future<Session?> read() async => null;
  @override
  Future<void> save(Session session) async =>
      throw StateError('Synthetic secure-storage failure');
  @override
  Future<void> clear() async {}
}

class DelayedClearStore implements SessionStore {
  final finishClear = Completer<void>();
  Session? value = session;
  int saves = 0;
  @override
  Future<Session?> read() async => value;
  @override
  Future<void> save(Session session) async {
    saves++;
    value = session;
  }

  @override
  Future<void> clear() async {
    await finishClear.future;
    value = null;
  }
}
