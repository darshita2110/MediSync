import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import '../session.dart';
import 'shared.dart';

class AuthPage extends StatefulWidget {
  const AuthPage({super.key, required this.controller});
  final SessionController controller;
  @override
  State<AuthPage> createState() => _AuthPageState();
}

class _AuthPageState extends State<AuthPage> {
  final form = GlobalKey<FormState>();
  final name = TextEditingController(),
      email = TextEditingController(),
      password = TextEditingController();
  bool signup = false, busy = false, obscured = true;
  String? error;
  @override
  void dispose() {
    name.dispose();
    email.dispose();
    password.dispose();
    super.dispose();
  }

  Future<void> submit() async {
    if (busy || !form.currentState!.validate()) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await widget.controller.authenticate(
          email: email.text.trim(),
          password: password.text,
          name: signup ? name.text.trim() : null);
    } catch (e) {
      if (mounted) setState(() => error = friendlyError(e));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
          body: SafeArea(child: LayoutBuilder(builder: (context, constraints) {
        final wide = constraints.maxWidth >= 950;
        final formView = Center(
            child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 470),
                child: Padding(
                    padding: const EdgeInsets.all(28),
                    child: AutofillGroup(
                        child: Form(
                            key: form,
                            child: Column(
                                mainAxisSize: MainAxisSize.min,
                                crossAxisAlignment: CrossAxisAlignment.stretch,
                                children: [
                                  if (!wide) ...[
                                    const Brand(),
                                    const SizedBox(height: 40)
                                  ],
                                  const StatusBadge('CARE, TOGETHER',
                                      icon: Icons.favorite_outline),
                                  const SizedBox(height: 22),
                                  Text(
                                      signup
                                          ? 'Start your care circle.'
                                          : 'Welcome back.',
                                      style: Theme.of(context)
                                          .textTheme
                                          .headlineLarge),
                                  const SizedBox(height: 10),
                                  Text(signup
                                      ? 'One account to coordinate care with the people you trust.'
                                      : 'A shared view of the medicines and people that matter.'),
                                  const SizedBox(height: 28),
                                  if (error != null ||
                                      widget.controller.message != null) ...[
                                    Panel(
                                        color: const Color(0xFFFFF0E4),
                                        padding: const EdgeInsets.all(14),
                                        child: Text(
                                            error ?? widget.controller.message!,
                                            style:
                                                const TextStyle(color: ink))),
                                    const SizedBox(height: 18)
                                  ],
                                  if (signup) ...[
                                    TextFormField(
                                        controller: name,
                                        enabled: !busy,
                                        autofillHints: const [
                                          AutofillHints.name
                                        ],
                                        textCapitalization:
                                            TextCapitalization.words,
                                        decoration: const InputDecoration(
                                            labelText: 'Your name'),
                                        validator: requiredText),
                                    const SizedBox(height: 16)
                                  ],
                                  TextFormField(
                                      controller: email,
                                      enabled: !busy,
                                      autofillHints: const [
                                        AutofillHints.email
                                      ],
                                      keyboardType: TextInputType.emailAddress,
                                      textInputAction: TextInputAction.next,
                                      decoration: const InputDecoration(
                                          labelText: 'Email address'),
                                      validator: (value) => value != null &&
                                              RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$')
                                                  .hasMatch(value.trim())
                                          ? null
                                          : 'Enter a valid email address'),
                                  const SizedBox(height: 16),
                                  TextFormField(
                                      controller: password,
                                      enabled: !busy,
                                      obscureText: obscured,
                                      autocorrect: false,
                                      enableSuggestions: false,
                                      autofillHints: [
                                        signup
                                            ? AutofillHints.newPassword
                                            : AutofillHints.password
                                      ],
                                      onFieldSubmitted: (_) => submit(),
                                      decoration: InputDecoration(
                                          labelText: 'Password',
                                          helperText: signup
                                              ? 'At least 8 characters'
                                              : null,
                                          suffixIcon: IconButton(
                                              tooltip: obscured
                                                  ? 'Show password'
                                                  : 'Hide password',
                                              onPressed: () => setState(
                                                  () => obscured = !obscured),
                                              icon: Icon(obscured
                                                  ? Icons.visibility_outlined
                                                  : Icons
                                                      .visibility_off_outlined))),
                                      validator: (value) {
                                        if (value == null || value.isEmpty) {
                                          return 'Enter your password';
                                        }
                                        if (signup && value.length < 8) {
                                          return 'Use at least 8 characters';
                                        }
                                        if (utf8.encode(value).length > 72) {
                                          return 'Use a password within 72 UTF-8 bytes';
                                        }
                                        return null;
                                      }),
                                  const SizedBox(height: 26),
                                  FilledButton(
                                      onPressed: busy ? null : submit,
                                      child: busy
                                          ? const SizedBox(
                                              width: 22,
                                              height: 22,
                                              child: CircularProgressIndicator(
                                                  strokeWidth: 2))
                                          : Text(signup
                                              ? 'Create account'
                                              : 'Sign in')),
                                  const SizedBox(height: 14),
                                  TextButton(
                                      onPressed: busy
                                          ? null
                                          : () => setState(() {
                                                signup = !signup;
                                                error = null;
                                                password.clear();
                                              }),
                                      child: Text(signup
                                          ? 'Already have an account? Sign in'
                                          : 'New to MediSync? Create an account')),
                                  if (kIsWeb) ...[
                                    const SizedBox(height: 16),
                                    const Text(
                                        'For privacy, browser sessions end when this page is refreshed.',
                                        textAlign: TextAlign.center,
                                        style: TextStyle(
                                            fontSize: 12, color: muted))
                                  ],
                                ]))))));
        return Row(children: [
          if (wide)
            Expanded(
                child: Container(
                    margin: const EdgeInsets.all(20),
                    padding: const EdgeInsets.all(52),
                    decoration: BoxDecoration(
                        color: ink, borderRadius: BorderRadius.circular(30)),
                    child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Brand(light: true),
                          const Spacer(),
                          const Icon(Icons.diversity_1_outlined,
                              size: 68, color: Color(0xFFB1D6B3)),
                          const SizedBox(height: 32),
                          const Text('Every prescription.\nOne shared view.',
                              style: TextStyle(
                                  color: Colors.white,
                                  fontSize: 46,
                                  fontWeight: FontWeight.w600,
                                  height: 1.15,
                                  letterSpacing: -1.5)),
                          const SizedBox(height: 24),
                          const Text(
                              'Keep track of what was prescribed, when a dose is due, and who has already helped.',
                              style: TextStyle(
                                  color: Color(0xFFCDDDD5),
                                  fontSize: 17,
                                  height: 1.6)),
                          const Spacer(),
                          const Text(
                              'Clarity for patients. Connection for caregivers.',
                              style: TextStyle(color: Color(0xFFB1D6B3))),
                        ]))),
          Expanded(child: SingleChildScrollView(child: formView))
        ]);
      })));
}
