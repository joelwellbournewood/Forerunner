@echo off
rem publish-release: tag the head of the default branch with the version it carries and push the
rem tag, which starts .github/workflows/release.yml. Double-click it; it asks once before it
rem publishes. Same steps as publish-release.sh.
rem
rem   FORERUNNER_REPO    the repository URL (default: the clone this file is in; else it asks)
rem   FORERUNNER_BRANCH  the branch to tag (default claude/forerunner-1-0-build-o53s04)
rem
rem It refuses when the tag exists or CHANGELOG.md has no section for the version, and works in a
rem temporary clone that it deletes afterwards.
setlocal EnableExtensions EnableDelayedExpansion

set "BRANCH=%FORERUNNER_BRANCH%"
if not defined BRANCH set "BRANCH=claude/forerunner-1-0-build-o53s04"
set "REPO=%FORERUNNER_REPO%"
rem REPO_DEFAULT is filled in by a copy made for one repository.
if not defined REPO set "REPO=%REPO_DEFAULT%"

where git >nul 2>nul
if errorlevel 1 (
  echo Git is not installed. Install it from https://git-scm.com/download/win ^(or: winget install Git.Git^), then run this again.
  goto :fail
)
if not defined REPO (
  for /f "usebackq delims=" %%u in (`git -C "%~dp0." remote get-url origin 2^>nul`) do set "REPO=%%u"
)
if not defined REPO set /p "REPO=Repository URL (for example https://github.com/<owner>/<repo>.git): "
if not defined REPO goto :fail

set "WORK=%TEMP%\forerunner-release-%RANDOM%%RANDOM%"
echo Fetching %BRANCH% from %REPO% ...
git clone --quiet --depth 1 --branch "%BRANCH%" "%REPO%" "%WORK%"
if errorlevel 1 goto :fail
pushd "%WORK%"

set "VERSION="
for /f "tokens=2 delims=:" %%v in ('findstr /b /c:"  \"version\"" package.json') do (
  if not defined VERSION set "VERSION=%%v"
)
if not defined VERSION (
  echo No version in package.json.
  goto :failpop
)
set "VERSION=!VERSION:"=!"
set "VERSION=!VERSION:,=!"
set "VERSION=!VERSION: =!"
set "TAG=v!VERSION!"

findstr /b /c:"## [!VERSION!]" CHANGELOG.md >nul
if errorlevel 1 (
  echo CHANGELOG.md has no [!VERSION!] section; this is not a prepared release.
  goto :failpop
)
set "EXISTS="
for /f %%t in ('git ls-remote --tags origin "refs/tags/!TAG!"') do set "EXISTS=1"
if defined EXISTS (
  echo !TAG! already exists; nothing to do.
  goto :failpop
)
for /f "usebackq delims=" %%L in (`git log -1 "--format=%%h: %%s"`) do set "HEADLINE=%%L"

echo.
echo   Release !TAG!
echo   Commit  !HEADLINE!
echo   Branch  %BRANCH%
echo.
set "ANSWER="
set /p "ANSWER=Publish !TAG!? This builds and publishes the release. Type y and press Enter: "
if /i not "!ANSWER!"=="y" (
  echo Nothing published.
  goto :failpop
)
git tag "!TAG!" HEAD
if errorlevel 1 goto :failpop
git push --quiet origin "refs/tags/!TAG!"
if errorlevel 1 goto :failpop
echo Pushed !TAG!. The release builds now.
set "PAGE=!REPO:.git=!"
if /i "!PAGE:~0,19!"=="https://github.com/" (
  echo Watch it: !PAGE!/actions/workflows/release.yml
  start "" "!PAGE!/actions/workflows/release.yml"
)
popd
rmdir /s /q "%WORK%" 2>nul
echo.
pause
exit /b 0

:failpop
popd
rmdir /s /q "%WORK%" 2>nul
:fail
echo.
pause
exit /b 1
