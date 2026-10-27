import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'session.dart';
import 'push.dart';
import 'ui/notification_review_page.dart';
import 'ui/auth_page.dart';
import 'ui/patients_page.dart';
import 'ui/shared.dart';

class MediSyncApp extends StatefulWidget {
  const MediSyncApp({super.key, required this.controller, this.push});
  final SessionController controller;
  final PushController? push;
  @override
  State<MediSyncApp> createState() => _MediSyncAppState();
}

class _MediSyncAppState extends State<MediSyncApp> {
  var navigatorKey = GlobalKey<NavigatorState>();
  int navigationRevision = -1;
  SessionController get controller => widget.controller;
  @override
  void initState() {
    super.initState();
    widget.push?.addListener(openIntent);
    controller.addListener(openIntent);
    WidgetsBinding.instance.addPostFrameCallback((_) => openIntent());
  }

  void openIntent() {
    if (!mounted || !controller.initialized || controller.session == null) {
      return;
    }
    final intent = widget.push?.takeIntent();
    if (intent == null) return;
    final revision = controller.revision;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted ||
          controller.session == null ||
          revision != controller.revision) {
        return;
      }
      navigatorKey.currentState?.push<void>(MaterialPageRoute(
          builder: (_) => NotificationReviewPage(
              repo: controller.repository, intent: intent)));
    });
  }

  @override
  void dispose() {
    widget.push?.removeListener(openIntent);
    controller.removeListener(openIntent);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        if (navigationRevision != controller.revision) {
          navigationRevision = controller.revision;
          navigatorKey = GlobalKey<NavigatorState>();
        }
        return MaterialApp(
          // Recreate the navigator on auth changes, removing all patient routes and
          // open dialogs when a session expires or the user signs out.
          key: ValueKey(
              'session-${controller.revision}-${controller.session?.userId}'),
          navigatorKey: navigatorKey,
          title: 'MediSync', debugShowCheckedModeBanner: false,
          theme: appTheme(),
          localizationsDelegates: GlobalMaterialLocalizations.delegates,
          supportedLocales: const [Locale('en')],
          home: !controller.initialized
              ? const Scaffold(body: Center(child: CircularProgressIndicator()))
              : controller.session == null
                  ? AuthPage(controller: controller)
                  : PatientsPage(controller: controller, push: widget.push),
        );
      });
}
