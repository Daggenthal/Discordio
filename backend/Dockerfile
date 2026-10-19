FROM ghcr.io/steamdeckhomebrew/holo-base:3.7.20
 
RUN mkdir /pacman
RUN sed 's/# ParallelDownloads = 10/ParallelDownloads = 1/' /etc/pacman.conf
#For some reason connection gets closed if i try to download too much stuff concurrently

RUN pacman -Sydd --noconfirm --root /pacman --dbpath /var/lib/pacman \
gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad gst-plugins-ugly \
gst-plugins-base-libs gst-plugins-bad-libs gst-libav gst-plugin-pipewire \
faac libnice orc libcdio flac fluidsynth gupnp gupnp-igd gssdp libsrtp nss libvpx openssl \
libxml2 icu
# libxml2 + icu: the WebRTC plugin (via libnice / gupnp) needs libxml2.so.2, but
# newer SteamOS ships a libxml2 with a different version number, so
# webrtcbin wouldn't load without the bundled copy.

RUN rm -rf /pacman/usr/lib/p11-kit-trust.so /pacman/usr/lib/libnssckbi.so

COPY ./entrypoint.sh /
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]