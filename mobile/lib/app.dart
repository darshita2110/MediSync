import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'session.dart';
import 'ui/auth_page.dart';
import 'ui/patients_page.dart';
import 'ui/shared.dart';

class MediSyncApp extends StatelessWidget {
  const MediSyncApp({super.key, required this.controller});
  final SessionController controller;
  @override
  Widget build(BuildContext context) => AnimatedBuilder(
      animation: controller,
      builder: (context, _) => MaterialApp(
            // Recreate the navigator on auth changes, removing all patient routes and
            // open dialogs when a session expires or the user signs out.
            key: ValueKey(
                'session-${controller.revision}-${controller.session?.userId}'),
            title: 'MediSync', debugShowCheckedModeBanner: false,
            theme: appTheme(),
            localizationsDelegates: GlobalMaterialLocalizations.delegates,
            supportedLocales: const [Locale('en')],
            home: !controller.initialized
                ? const Scaffold(
                    body: Center(child: CircularProgressIndicator()))
                : controller.session == null
                    ? AuthPage(controller: controller)
                    : PatientsPage(controller: controller),
          ));
}
