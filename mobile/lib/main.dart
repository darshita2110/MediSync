import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:timezone/data/latest_all.dart' as tz;
import 'api.dart';
import 'app.dart';
import 'config.dart';
import 'session.dart';
import 'ui/shared.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  tz.initializeTimeZones();
  try {
    final api = ApiClient(baseUrl: resolveApiBase());
    final controller = SessionController(
        Repository(api), kIsWeb ? MemorySessionStore() : SecureSessionStore());
    runApp(MediSyncApp(controller: controller));
    controller.initialize();
  } on FormatException {
    runApp(MaterialApp(
        theme: appTheme(),
        home: const Scaffold(
            body: Center(
                child: Padding(
                    padding: EdgeInsets.all(28),
                    child: Text(
                        'The connection is not configured for this build. Please contact the person who provided the app.'))))));
  }
}
