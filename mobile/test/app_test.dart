import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'package:medisync/api.dart';
import 'package:medisync/app.dart';
import 'package:medisync/models.dart';
import 'package:medisync/session.dart';
import 'package:timezone/data/latest_all.dart' as tz;
import 'fake_server.dart';

Future<SessionController> launch(WidgetTester tester, FakeServer server,
    {bool signedIn = true}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(430, 900);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final api = ApiClient(
      baseUrl: Uri.parse('https://api.example.test'),
      transport: MockClient(server.handle));
  final store = MemorySessionStore();
  if (signedIn) {
    await store.save(const Session(
        token: 'test-token',
        userId: 'user-1',
        email: 'priya@example.com',
        name: 'Priya'));
  }
  final controller = SessionController(Repository(api), store);
  addTearDown(controller.dispose);
  await controller.initialize();
  await tester.pumpWidget(MediSyncApp(controller: controller));
  await tester.pumpAndSettle();
  return controller;
}

Future<void> openPatient(WidgetTester tester) async {
  await tester.ensureVisible(find.text('Asha Rao'));
  await tester.pumpAndSettle();
  await tester.tap(find.text('Asha Rao'));
  await tester.pumpAndSettle();
}

Finder takenButton() => find.ancestor(
    of: find.text('Taken'),
    matching: find.byWidgetPredicate((w) => w is ButtonStyleButton));

Future<void> chooseTab(WidgetTester tester, String name) async {
  await tester.tap(find.descendant(
      of: find.byType(NavigationBar), matching: find.text(name)));
  await tester.pumpAndSettle();
}

void main() {
  setUpAll(tz.initializeTimeZones);

  testWidgets(
      'sign-in validates fields and opens the real repository dashboard',
      (tester) async {
    final server = FakeServer();
    await launch(tester, server, signedIn: false);
    await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
    await tester.pumpAndSettle();
    expect(find.text('Enter a valid email address'), findsOneWidget);
    await tester.enterText(find.widgetWithText(TextFormField, 'Email address'),
        'priya@example.com');
    await tester.enterText(
        find.widgetWithText(TextFormField, 'Password'), 'test-password');
    await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
    await tester.pumpAndSettle();
    expect(find.text('Care, kept in sync.'), findsOneWidget);
    expect(find.text('Asha Rao'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('owner confirms a dose once and sees the returned shared record',
      (tester) async {
    final server = FakeServer();
    await launch(tester, server);
    await openPatient(tester);
    await tester.ensureVisible(takenButton());
    await tester.tap(takenButton());
    await tester.pumpAndSettle();
    expect(
        server.requests
            .where((r) => r.method == 'PATCH' && r.url.path.contains('/doses/'))
            .length,
        1);
    expect(find.textContaining('Recorded by Priya'), findsOneWidget);
    expect(takenButton(), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'helper sees today only, cannot manage records, and handles another caregiver winning',
      (tester) async {
    final server = FakeServer(role: 'helper')..conflictOnConfirm = true;
    await launch(tester, server);
    await openPatient(tester);
    expect(find.byType(NavigationBar), findsNothing);
    expect(find.text('Choose date'), findsNothing);
    expect(server.requests.any((r) => r.url.path.endsWith('/doses/generate')),
        isFalse);
    await tester.ensureVisible(takenButton());
    await tester.tap(takenButton());
    await tester.pumpAndSettle();
    expect(find.textContaining('Already taken by Priya'), findsOneWidget);
    expect(find.textContaining('Recorded by Priya'), findsOneWidget);
    expect(takenButton(), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'viewer reads the timeline and medical records without mutation controls',
      (tester) async {
    final server = FakeServer(role: 'viewer');
    await launch(tester, server);
    await openPatient(tester);
    expect(takenButton(), findsNothing);
    await chooseTab(tester, 'Medicines');
    expect(find.text('Example medicine'), findsOneWidget);
    expect(find.text('Add prescription'), findsNothing);
    await chooseTab(tester, 'Review');
    expect(find.text('Check medicines'), findsNothing);
    await chooseTab(tester, 'People');
    expect(find.text('Invite caregiver'), findsNothing);
    expect(server.requests.any((r) => r.method != 'GET'), isFalse);
    expect(tester.takeException(), isNull);
  });

  testWidgets('an expired session clears patient routes and returns to sign-in',
      (tester) async {
    final server = FakeServer();
    final controller = await launch(tester, server);
    await openPatient(tester);
    server.unauthorized = true;
    await chooseTab(tester, 'Medicines');
    expect(controller.session, isNull);
    expect(await controller.store.read(), isNull);
    expect(find.text('Welcome back.'), findsOneWidget);
    expect(find.text('Asha Rao'), findsNothing);
    expect(find.text('Example medicine'), findsNothing);
  });

  testWidgets(
      'prescription entry sends recorded instructions and refreshes the medicine list',
      (tester) async {
    final server = FakeServer();
    await launch(tester, server);
    await openPatient(tester);
    await chooseTab(tester, 'Medicines');
    await tester.tap(find.text('Add prescription'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(
        find.widgetWithText(TextFormField, 'Medicine as written'));
    await tester.enterText(
        find.widgetWithText(TextFormField, 'Medicine as written'),
        'New recorded medicine');
    await tester.ensureVisible(
        find.widgetWithText(TextFormField, 'Dose as prescribed'));
    await tester.enterText(
        find.widgetWithText(TextFormField, 'Dose as prescribed'),
        'As on the prescription');
    await tester.tap(find.text('Save prescription'));
    await tester.pumpAndSettle();
    expect(
        server.requests
            .where((r) =>
                r.method == 'POST' && r.url.path.endsWith('/prescriptions'))
            .length,
        1);
    expect(find.text('New recorded medicine'), findsOneWidget);
    expect(find.text('Prescription saved.'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'schedule failures show a persistent receipt without recreating the prescription',
      (tester) async {
    final server = FakeServer()..failSchedules = true;
    await launch(tester, server);
    await openPatient(tester);
    await chooseTab(tester, 'Medicines');
    await tester.tap(find.text('Add prescription'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(
        find.widgetWithText(TextFormField, 'Medicine as written'));
    await tester.enterText(
        find.widgetWithText(TextFormField, 'Medicine as written'),
        'Scheduled medicine');
    await tester.ensureVisible(
        find.widgetWithText(TextFormField, 'Dose as prescribed'));
    await tester.enterText(
        find.widgetWithText(TextFormField, 'Dose as prescribed'),
        'As recorded');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Add dose time'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Add dose time'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('OK'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Save prescription'));
    await tester.pumpAndSettle();
    expect(find.text('Prescription saved; check dose times'), findsOneWidget);
    expect(
        server.requests
            .where((r) =>
                r.method == 'POST' && r.url.path.endsWith('/prescriptions'))
            .length,
        1);
    await tester.tap(find.text('Got it'));
    await tester.pumpAndSettle();
    expect(find.text('Scheduled medicine'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'large text on a narrow phone keeps the dashboard and timeline usable',
      (tester) async {
    final server = FakeServer();
    await launch(tester, server);
    tester.view.physicalSize = const Size(360, 900);
    tester.platformDispatcher.textScaleFactorTestValue = 1.8;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await openPatient(tester);
    expect(tester.takeException(), isNull);
  });
  testWidgets(
      'alerts show worker status, support shared snooze and persist read state',
      (tester) async {
    final server = FakeServer()
      ..doseTime = DateTime.now().subtract(const Duration(minutes: 1))
      ..workerAvailable = false;
    await launch(tester, server);
    await tester.tap(find.byTooltip('Care alerts'));
    await tester.pumpAndSettle();
    expect(find.textContaining('not checked in recently'), findsOneWidget);
    expect(find.textContaining('Reminders and family alerts, with'),
        findsOneWidget);
    await tester.ensureVisible(find.text('Snooze 10 min'));
    await tester.tap(find.text('Snooze 10 min'));
    await tester.pumpAndSettle();
    expect(
        server.requests.where((r) => r.url.path.endsWith('/snooze')).length, 1);
    expect(find.textContaining('Snoozed until'), findsOneWidget);
    await tester.ensureVisible(find.text('Mark read'));
    await tester.tap(find.text('Mark read'));
    await tester.pumpAndSettle();
    expect(server.alertRead, isTrue);
    expect(find.text('Mark read'), findsNothing);
    await tester.tap(find.byTooltip('Back'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });

  testWidgets('missed family alert records a late outcome and removes actions',
      (tester) async {
    final server = FakeServer()..doseStatus = 'missed';
    await launch(tester, server);
    tester.view.physicalSize = const Size(360, 900);
    tester.platformDispatcher.textScaleFactorTestValue = 1.8;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.tap(find.byTooltip('Care alerts'));
    await tester.pumpAndSettle();
    expect(find.text('Missed-dose family alert'), findsOneWidget);
    expect(find.text('Snooze 10 min'), findsNothing);
    await tester.ensureVisible(takenButton());
    await tester.pumpAndSettle();
    await tester.tap(takenButton());
    await tester.pumpAndSettle();
    expect(server.doseStatus, 'taken');
    expect(takenButton(), findsNothing);
    expect(find.textContaining('Recorded by Priya'), findsOneWidget);
    await tester.tap(find.byTooltip('Back'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'snoozing cannot overwrite a confirmation won by another caregiver',
      (tester) async {
    final server = FakeServer()
      ..doseTime = DateTime.now().subtract(const Duration(minutes: 1))
      ..conflictOnConfirm = true;
    await launch(tester, server);
    await openPatient(tester);
    await tester.ensureVisible(find.text('Snooze 10 min'));
    await tester.tap(find.text('Snooze 10 min'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Already taken by Priya'), findsOneWidget);
    expect(find.textContaining('Recorded by Priya'), findsOneWidget);
    expect(find.text('Snooze 10 min'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
