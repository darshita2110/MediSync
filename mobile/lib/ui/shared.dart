import 'package:flutter/material.dart';
import '../api.dart';
import '../calendar.dart';
import '../models.dart';

const ink = Color(0xFF173B35);
const teal = Color(0xFF126B5E);
const canvas = Color(0xFFF5F5EF);
const line = Color(0xFFDDE5DD);
const muted = Color(0xFF5C6F68);

ThemeData appTheme() => ThemeData(
      useMaterial3: true,
      colorScheme: ColorScheme.fromSeed(
          seedColor: teal, primary: teal, surface: Colors.white),
      scaffoldBackgroundColor: canvas,
      appBarTheme: const AppBarTheme(
          backgroundColor: canvas,
          foregroundColor: ink,
          surfaceTintColor: Colors.transparent),
      textTheme: const TextTheme(
        headlineLarge: TextStyle(
            fontSize: 36,
            height: 1.15,
            fontWeight: FontWeight.w700,
            letterSpacing: -1.1,
            color: ink),
        headlineMedium: TextStyle(
            fontSize: 27,
            height: 1.2,
            fontWeight: FontWeight.w700,
            letterSpacing: -.6,
            color: ink),
        titleLarge:
            TextStyle(fontSize: 21, fontWeight: FontWeight.w600, color: ink),
        titleMedium:
            TextStyle(fontSize: 17, fontWeight: FontWeight.w600, color: ink),
        bodyLarge: TextStyle(fontSize: 16, height: 1.5, color: ink),
        bodyMedium: TextStyle(fontSize: 14, height: 1.5, color: muted),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: const Color(0xFFFAFBF8),
        contentPadding: const EdgeInsets.all(16),
        border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: line)),
        enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: line)),
      ),
      filledButtonTheme: FilledButtonThemeData(
          style: FilledButton.styleFrom(
        minimumSize: const Size(48, 48),
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      )),
      outlinedButtonTheme: OutlinedButtonThemeData(
          style: OutlinedButton.styleFrom(
        minimumSize: const Size(48, 48),
        side: const BorderSide(color: line),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      )),
      navigationBarTheme: const NavigationBarThemeData(
          backgroundColor: Colors.white, indicatorColor: Color(0xFFE1EEE5)),
    );

String friendlyError(Object error) => error is ApiException
    ? error.message
    : 'Something went wrong. Please try again.';
void notice(BuildContext context, String message) => ScaffoldMessenger.of(
    context)
  ..hideCurrentSnackBar()
  ..showSnackBar(
      SnackBar(content: Text(message), behavior: SnackBarBehavior.floating));

class Brand extends StatelessWidget {
  const Brand({super.key, this.light = false});
  final bool light;
  @override
  Widget build(BuildContext context) =>
      Row(mainAxisSize: MainAxisSize.min, children: [
        Container(
            padding: const EdgeInsets.all(9),
            decoration: BoxDecoration(
                color: light ? Colors.white24 : teal,
                borderRadius: BorderRadius.circular(12)),
            child: const Icon(Icons.medication_rounded,
                color: Colors.white, size: 25)),
        const SizedBox(width: 10),
        Flexible(
            child: Text('MediSync',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                    fontSize: 23,
                    fontWeight: FontWeight.w700,
                    letterSpacing: -.7,
                    color: light ? Colors.white : ink))),
      ]);
}

class Panel extends StatelessWidget {
  const Panel(
      {super.key,
      required this.child,
      this.padding = const EdgeInsets.all(22),
      this.color = Colors.white});
  final Widget child;
  final EdgeInsets padding;
  final Color color;
  @override
  Widget build(BuildContext context) => Container(
      padding: padding,
      decoration: BoxDecoration(
          color: color,
          border: Border.all(color: line),
          borderRadius: BorderRadius.circular(20)),
      child: child);
}

class StatusBadge extends StatelessWidget {
  const StatusBadge(this.label, {super.key, this.color = teal, this.icon});
  final String label;
  final Color color;
  final IconData? icon;
  @override
  Widget build(BuildContext context) => Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
          color: color.withValues(alpha: .09),
          borderRadius: BorderRadius.circular(8)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        if (icon != null) ...[
          Icon(icon, size: 15, color: color),
          const SizedBox(width: 5)
        ],
        Flexible(
            child: Text(label,
                style: TextStyle(
                    color: color, fontSize: 12, fontWeight: FontWeight.w600)))
      ]));
}

class EmptyState extends StatelessWidget {
  const EmptyState(
      {super.key,
      required this.title,
      required this.message,
      this.icon = Icons.spa_outlined,
      this.action});
  final String title, message;
  final IconData icon;
  final Widget? action;
  @override
  Widget build(BuildContext context) => Panel(
      child: Center(
          child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 25),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                Icon(icon, color: teal, size: 38),
                const SizedBox(height: 15),
                Text(title,
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.titleLarge),
                const SizedBox(height: 8),
                ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 390),
                    child: Text(message, textAlign: TextAlign.center)),
                if (action != null) ...[const SizedBox(height: 20), action!],
              ]))));
}

class ErrorPanel extends StatelessWidget {
  const ErrorPanel(this.error, {super.key, required this.retry});
  final Object error;
  final VoidCallback retry;
  @override
  Widget build(BuildContext context) => EmptyState(
      title: 'Could not load this view',
      message: friendlyError(error),
      icon: Icons.cloud_off_outlined,
      action: OutlinedButton.icon(
          onPressed: retry,
          icon: const Icon(Icons.refresh),
          label: const Text('Try again')));
}

class AsyncSection<T> extends StatelessWidget {
  const AsyncSection(
      {super.key,
      required this.future,
      required this.retry,
      required this.builder});
  final Future<T> future;
  final VoidCallback retry;
  final Widget Function(T) builder;
  @override
  Widget build(BuildContext context) => FutureBuilder<T>(
      future: future,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Padding(
              padding: EdgeInsets.all(55),
              child: Center(child: CircularProgressIndicator()));
        }
        if (snapshot.hasError) return ErrorPanel(snapshot.error!, retry: retry);
        return builder(snapshot.data as T);
      });
}

class SectionTitle extends StatelessWidget {
  const SectionTitle(this.title, {super.key, this.subtitle, this.action});
  final String title;
  final String? subtitle;
  final Widget? action;
  @override
  Widget build(BuildContext context) => Padding(
      padding: const EdgeInsets.only(bottom: 20),
      child: Wrap(
          spacing: 20,
          runSpacing: 12,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: Theme.of(context).textTheme.headlineMedium),
              if (subtitle != null) ...[
                const SizedBox(height: 5),
                Text(subtitle!)
              ],
            ]),
            if (action != null) action!,
          ]));
}

class ContentList extends StatelessWidget {
  const ContentList({super.key, required this.children, this.onRefresh});
  final List<Widget> children;
  final Future<void> Function()? onRefresh;
  @override
  Widget build(BuildContext context) {
    final list = ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(20),
        children: [
          Center(
              child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 1050),
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: children)))
        ]);
    return onRefresh == null
        ? list
        : RefreshIndicator(onRefresh: onRefresh!, child: list);
  }
}

class RunButton extends StatefulWidget {
  const RunButton(
      {super.key,
      required this.label,
      required this.run,
      this.icon = Icons.check,
      this.outlined = false});
  final String label;
  final Future<void> Function() run;
  final IconData icon;
  final bool outlined;
  @override
  State<RunButton> createState() => _RunButtonState();
}

class _RunButtonState extends State<RunButton> {
  bool busy = false;
  Future<void> run() async {
    setState(() => busy = true);
    try {
      await widget.run();
    } catch (e) {
      if (mounted) notice(context, friendlyError(e));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final icon = busy
        ? const SizedBox(
            width: 18,
            height: 18,
            child: CircularProgressIndicator(strokeWidth: 2))
        : Icon(widget.icon, size: 19);
    return widget.outlined
        ? OutlinedButton.icon(
            onPressed: busy ? null : run, icon: icon, label: Text(widget.label))
        : FilledButton.icon(
            onPressed: busy ? null : run,
            icon: icon,
            label: Text(widget.label));
  }
}

Future<bool> confirmAction(BuildContext context,
        {required String title,
        required String message,
        String confirm = 'Confirm'}) async =>
    await showDialog<bool>(
        context: context,
        builder: (context) =>
            AlertDialog(title: Text(title), content: Text(message), actions: [
              TextButton(
                  onPressed: () => Navigator.pop(context, false),
                  child: const Text('Cancel')),
              FilledButton(
                  onPressed: () => Navigator.pop(context, true),
                  child: Text(confirm))
            ])) ??
    false;

class FormDialog extends StatelessWidget {
  const FormDialog(
      {super.key,
      required this.title,
      required this.formKey,
      required this.children,
      required this.onSave,
      required this.busy,
      this.error,
      this.saveLabel = 'Save',
      this.subtitle});
  final String title, saveLabel;
  final String? subtitle, error;
  final GlobalKey<FormState> formKey;
  final List<Widget> children;
  final VoidCallback onSave;
  final bool busy;
  @override
  Widget build(BuildContext context) => PopScope(
      canPop: !busy,
      child: AlertDialog(
          scrollable: true,
          title: Text(title),
          content: SizedBox(
              width: 560,
              child: Form(
                  key: formKey,
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        if (subtitle != null) ...[
                          Text(subtitle!),
                          const SizedBox(height: 18)
                        ],
                        if (error != null) ...[
                          Text(error!,
                              style: TextStyle(
                                  color: Theme.of(context).colorScheme.error)),
                          const SizedBox(height: 14)
                        ],
                        IgnorePointer(
                            ignoring: busy,
                            child: Column(
                                crossAxisAlignment: CrossAxisAlignment.stretch,
                                children: [
                                  for (final child in children)
                                    Padding(
                                        padding:
                                            const EdgeInsets.only(bottom: 16),
                                        child: child)
                                ])),
                      ]))),
          actions: [
            TextButton(
                onPressed: busy ? null : () => Navigator.pop(context),
                child: const Text('Cancel')),
            FilledButton(
                onPressed: busy ? null : onSave,
                child: busy
                    ? const SizedBox(
                        width: 22,
                        height: 22,
                        child: CircularProgressIndicator(strokeWidth: 2))
                    : Text(saveLabel))
          ]));
}

String? requiredText(String? value) =>
    value == null || value.trim().isEmpty ? 'Please fill this in' : null;

class DateField extends StatelessWidget {
  const DateField(
      {super.key,
      required this.label,
      required this.value,
      required this.onChanged,
      this.first,
      this.last,
      this.clearable = true});
  final String label;
  final DateTime? value, first, last;
  final void Function(DateTime?) onChanged;
  final bool clearable;
  @override
  Widget build(BuildContext context) => InkWell(
      borderRadius: BorderRadius.circular(12),
      onTap: () async {
        final earliest = first ?? DateTime(1900);
        final latest = last ?? DateTime(2100, 12, 31);
        var initial = value ?? DateTime.now();
        if (initial.isBefore(earliest)) initial = earliest;
        if (initial.isAfter(latest)) initial = latest;
        final result = await showDatePicker(
            context: context,
            initialDate: initial,
            firstDate: earliest,
            lastDate: latest);
        if (result != null) onChanged(result);
      },
      child: InputDecorator(
          decoration: InputDecoration(
              labelText: label,
              suffixIcon: value == null || !clearable
                  ? const Icon(Icons.calendar_today_outlined, size: 20)
                  : IconButton(
                      tooltip: 'Clear $label',
                      onPressed: () => onChanged(null),
                      icon: const Icon(Icons.close, size: 18))),
          child: Text(value == null ? 'Not set' : displayDate(dateKey(value!)),
              style: const TextStyle(color: ink, fontSize: 16))));
}

String roleValue(PatientRole role) => switch (role) {
      PatientRole.owner => 'owner',
      PatientRole.familyAdmin => 'family_admin',
      PatientRole.helper => 'helper',
      PatientRole.viewer => 'viewer',
    };
